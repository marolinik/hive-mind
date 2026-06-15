/**
 * raw-turns.ts — per-turn verbatim dialogue storage (write side).
 *
 * Benchmark ablation attributed the single-hop win to the raw-detail
 * escalation lane — fine-grained perceptual detail survives ONLY in
 * verbatim turns; the distillation passes carry it generically. This
 * module stores each conversation turn as its own frame so the
 * recall-side raw-detail lane can pool / rerank / neighbor-expand them.
 *
 * Frame convention (first line is the lane tag; body is the verbatim turn):
 *
 *   `[mind-rawturn conv:<key> turn:<n> speaker:<s>]\n<turn text>`
 *
 *   - `conv:<key>`  sanitized item id — groups turns of one conversation
 *   - `turn:<n>`    contiguous index over STORED turns (dialogue order) —
 *                   the ±1 adjacency key. Production frames interleave
 *                   across sources, so id-ordering does not transfer;
 *                   the index makes adjacency explicit.
 *   - `speaker:<s>` sanitized role/name (no whitespace, no `]`)
 *
 * `[mind-` prefixing keeps raw turns out of the memory-lane extraction
 * passes' source material (their `NOT LIKE '[mind-%'` self-feeding guard)
 * and lets recall dedup them against the snippet lanes by content prefix.
 *
 * Every turn is injection-scanned BEFORE write: verbatim dialogue is the
 * most injection-prone frame class — poisoned turns must die here, not at
 * recall time.
 *
 * Storage growth is the accepted tradeoff. Callers gate writes on the
 * `HIVE_MIND_RAWDETAIL` env kill switch (see RAWDETAIL_KILL_SWITCH).
 *
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 */

import type { FrameStore } from '../mind/frames.js';
import type { UniversalImportItem } from './types.js';
import { HARVEST_FRAME_CONTENT_CAP } from './types.js';
import { scanForInjection } from '../injection-scanner.js';
import { createCoreLogger } from '../logger.js';

const log = createCoreLogger('raw-turns');

/** First-line content prefix for raw-turn frames (recall lane fetches by this). */
export const MIND_RAWTURN_PREFIX = '[mind-rawturn';

/** Hard per-conversation cap — backstop against pathological exports.
 *  Long benchmark conversations run ~600 turns; 2000 leaves generous headroom. */
export const MAX_TURNS_PER_ITEM = 2000;

/** Env kill switch (checked by CALLERS, mirrored here for the recall lane).
 *  Set `HIVE_MIND_RAWDETAIL=off` to disable raw-turn storage at ingest. */
export const RAWDETAIL_KILL_SWITCH = 'HIVE_MIND_RAWDETAIL';

export interface WriteRawTurnsResult {
  written: number;
  skippedEmpty: number;
  injectionDropped: number;
  /** true when MAX_TURNS_PER_ITEM truncated the conversation (logged, never silent). */
  capped: boolean;
}

/** Strict ISO-8601 gate (same contract as FrameStore.createIFrame). */
function isIsoTimestamp(value: string | undefined): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

/** Sanitize a header token: keep [A-Za-z0-9_-], collapse everything else to '-'.
 *  Removes `]`, whitespace, and LIKE metacharacters. */
function sanitizeToken(value: string, maxLen: number): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'unknown').slice(0, maxLen);
}

/** Build the raw-turn header for conv/turn/speaker. Exported for the recall
 *  lane's neighbor lookups (single source of truth for the format). */
export function rawTurnHeader(convKey: string, turn: number, speaker: string): string {
  return `${MIND_RAWTURN_PREFIX} conv:${convKey} turn:${turn} speaker:${speaker}]`;
}

export interface ParsedRawTurnHeader {
  conv: string;
  turn: number;
  speaker: string;
}

/** Parse a raw-turn frame's first line. Returns null for non-rawturn content. */
export function parseRawTurnHeader(content: string): ParsedRawTurnHeader | null {
  const m = content.match(/^\[mind-rawturn conv:([A-Za-z0-9_-]+) turn:(\d+) speaker:([A-Za-z0-9_-]+)\]/);
  if (!m) return null;
  return { conv: m[1], turn: parseInt(m[2], 10), speaker: m[3] };
}

/** Conversation key for an import item (sanitized, stable across re-imports). */
export function rawTurnConvKey(item: Pick<UniversalImportItem, 'id' | 'source'>): string {
  return sanitizeToken(`${item.source}-${item.id}`, 64);
}

/**
 * Store each user/assistant turn of `item.messages` as a `[mind-rawturn …]`
 * frame. No-op (all zeros) when the item carries no messages.
 *
 * - turn index is contiguous over STORED turns (skips don't leave gaps —
 *   ±1 adjacency stays meaningful over the stored dialogue)
 * - system messages are skipped (boilerplate, not dialogue evidence)
 * - created_at: message timestamp if valid ISO, else item timestamp, else
 *   schema default (createIFrame validates again — never writes junk)
 * - importance 'normal' (stays out of the importance lane), source 'import'
 * - createIFrame content-dedup makes re-imports idempotent within its
 *   recency window; source-level content hashing (harvestSetHash) guards
 *   the wider case (unchanged exports never reach here)
 */
export function writeRawTurnFrames(
  frames: FrameStore,
  gopId: string,
  item: UniversalImportItem,
): WriteRawTurnsResult {
  const result: WriteRawTurnsResult = {
    written: 0, skippedEmpty: 0, injectionDropped: 0, capped: false,
  };
  const messages = item.messages;
  if (!Array.isArray(messages) || messages.length === 0) return result;

  const convKey = rawTurnConvKey(item);
  const itemTs = isIsoTimestamp(item.timestamp) ? item.timestamp : undefined;

  let turn = 0;
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = (msg.text ?? '').trim();
    if (text.length === 0) {
      result.skippedEmpty++;
      continue;
    }
    if (turn >= MAX_TURNS_PER_ITEM) {
      result.capped = true;
      break;
    }
    // Scan first 4KB — same probe budget as the harvest pipeline's Pass 0.
    const scan = scanForInjection(text.slice(0, 4000), 'tool_output');
    if (!scan.safe) {
      result.injectionDropped++;
      log.warn('dropping raw turn with injection payload', {
        conv: convKey, turn, flags: scan.flags.join(','),
      });
      continue;
    }
    const speaker = sanitizeToken(msg.role, 24);
    const createdAt = isIsoTimestamp(msg.timestamp) ? msg.timestamp : itemTs;
    frames.createIFrame(
      gopId,
      `${rawTurnHeader(convKey, turn, speaker)}\n${text.slice(0, HARVEST_FRAME_CONTENT_CAP)}`,
      'normal',
      'import',
      createdAt,
    );
    result.written++;
    turn++;
  }

  if (result.capped) {
    log.warn('raw-turn storage capped — conversation exceeds MAX_TURNS_PER_ITEM', {
      conv: convKey, stored: result.written, totalMessages: messages.length,
    });
  }
  return result;
}

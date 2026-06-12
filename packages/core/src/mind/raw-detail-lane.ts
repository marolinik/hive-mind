// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
/**
 * raw-detail-lane.ts — RAWDETAIL escalation lane (recall side).
 *
 * Benchmark-proven retrieval over verbatim dialogue turns (LoCoMo W3.3:
 * single-hop 92.75 +4.52 z=3.16; W3.4 ablation: this lane is the delivery
 * mechanism, +2.40 z=1.95 on top of caption parity). Pipeline:
 *
 *   pool (date-window filtered turns, else FTS BM25 top-60)
 *     → cross-encoder rerank, keep top K (default 6)
 *     → expand ±1 dialogue neighbors (gold often sits ADJACENT to the top
 *       CE hit — Q→A conversational adjacency)
 *     → dedup vs already-rendered frames, chronological render order
 *
 * Turns are stored by `harvest/raw-turns.ts` with explicit
 * `conv:<key> turn:<n>` header keys — production frames interleave across
 * sources, so adjacency is looked up per-conversation by turn index, not
 * by row-id ordering (the benchmark's trick that does not transfer).
 *
 * The lane REQUIRES a reranker (the CE step is what makes the pool pay —
 * P5 anti-goal: no relevance-only episodic injection without the CE floor);
 * callers skip the lane entirely when no reranker is available.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type { Reranker } from './inprocess-reranker.js';
import { MIND_RAWTURN_PREFIX, parseRawTurnHeader } from '../harvest/raw-turns.js';

/** CE survivors kept before neighbor expansion (benchmark RAWDETAIL_K). */
export const RAW_DETAIL_K = 6;
/** FTS pool size (benchmark: BM25 top-60). */
const FTS_POOL_LIMIT = 60;
/** Window pools larger than this get FTS-intersected (benchmark: 120). */
const WINDOW_POOL_MAX = 120;

export interface RawTurnHit {
  id: number;
  content: string;
  created_at: string;
  conv: string;
  turn: number;
  speaker: string;
}

export interface RawDetailLaneOptions {
  /** CE survivors before neighbor expansion (default RAW_DETAIL_K = 6). */
  k?: number;
  /** Explicit-period window from the query (recallMemory's parseDateWindow). */
  window?: { since: string; until: string } | null;
  /** Frame ids already rendered by other lanes — excluded from the result. */
  excludeIds?: Set<number>;
}

type FrameRow = { id: number; content: string; created_at: string };

/** Body of a raw-turn frame (everything after the header line). */
export function rawTurnBody(content: string): string {
  const nl = content.indexOf('\n');
  return nl >= 0 ? content.slice(nl + 1).trim() : content;
}

/** FTS5 OR-query sanitizer — mirrors HybridSearch.keywordSearch (W3.6). */
const FTS_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'this',
  'that', 'these', 'those', 'it', 'its', 'my', 'your', 'our', 'their',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'all',
  'each', 'every', 'both', 'some', 'any', 'no', 'not', 'and', 'or', 'but',
]);

function ftsOrQuery(query: string): string {
  return query
    .split(/\s+/)
    .map(w => w.replace(/[^\w]/g, ''))
    .filter(w => w.length > 2 && !FTS_STOP_WORDS.has(w.toLowerCase()))
    .map(w => `"${w}"`)
    .join(' OR ');
}

/** FTS BM25 top-N restricted to raw-turn frames. Returns [] on FTS parse errors. */
function ftsPool(db: DatabaseType, query: string, limit: number): FrameRow[] {
  const match = ftsOrQuery(query);
  if (!match) return [];
  try {
    return db.prepare(
      `SELECT mf.id, mf.content, mf.created_at
       FROM memory_frames_fts fts
       JOIN memory_frames mf ON mf.id = fts.rowid
       WHERE fts.content MATCH ? AND mf.content LIKE '${MIND_RAWTURN_PREFIX} %'
       ORDER BY rank
       LIMIT ?`
    ).all(match, limit) as FrameRow[];
  } catch {
    return [];
  }
}

/** All raw-turn frames whose created_at date falls inside [since..until]. */
function windowPool(db: DatabaseType, since: string, until: string): FrameRow[] {
  return db.prepare(
    `SELECT id, content, created_at FROM memory_frames
     WHERE content LIKE '${MIND_RAWTURN_PREFIX} %'
       AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
     ORDER BY id ASC`
  ).all(since, until) as FrameRow[];
}

/** Fetch every stored turn of one conversation, keyed by turn index. */
function convTurnMap(db: DatabaseType, conv: string): Map<number, FrameRow> {
  // conv keys are sanitized to [A-Za-z0-9_-] at write time — no LIKE
  // metacharacters can appear, so direct interpolation into the pattern
  // parameter (still a BOUND parameter) is safe.
  const rows = db.prepare(
    `SELECT id, content, created_at FROM memory_frames
     WHERE content LIKE ?`
  ).all(`${MIND_RAWTURN_PREFIX} conv:${conv} %`) as FrameRow[];
  const map = new Map<number, FrameRow>();
  for (const r of rows) {
    const h = parseRawTurnHeader(r.content);
    if (h && h.conv === conv) map.set(h.turn, r);
  }
  return map;
}

/**
 * Run the RAWDETAIL lane over one mind's raw-turn frames.
 * Returns CE-top turns ±1 dialogue neighbors, chronologically ordered,
 * excluding `excludeIds`. Empty array when no turns / no pool / no signal.
 */
export async function fetchRawDetailLane(
  db: DatabaseType,
  query: string,
  reranker: Reranker,
  opts: RawDetailLaneOptions = {},
): Promise<RawTurnHit[]> {
  const k = opts.k ?? RAW_DETAIL_K;
  const excludeIds = opts.excludeIds ?? new Set<number>();

  // ── Pool ──────────────────────────────────────────────────────────────
  let pool: FrameRow[] = [];
  if (opts.window) {
    pool = windowPool(db, opts.window.since, opts.window.until);
    if (pool.length > WINDOW_POOL_MAX) {
      // Benchmark behavior: oversized window → intersect with FTS top-60;
      // FTS-empty falls back to the first WINDOW_POOL_MAX turns.
      const winIds = new Set(pool.map(t => t.id));
      const fts = ftsPool(db, query, 200).filter(t => winIds.has(t.id)).slice(0, FTS_POOL_LIMIT);
      pool = fts.length > 0 ? fts : pool.slice(0, WINDOW_POOL_MAX);
    }
    // Window matched nothing (period off-corpus) → fall through to FTS so
    // the lane never LOSES recall, only sharpens it.
    if (pool.length === 0) pool = ftsPool(db, query, FTS_POOL_LIMIT);
  } else {
    pool = ftsPool(db, query, FTS_POOL_LIMIT);
  }
  if (pool.length === 0) return [];

  // ── Cross-encoder rerank → top K ─────────────────────────────────────
  const docs = pool.map(t => rawTurnBody(t.content));
  let scores: number[];
  try {
    scores = await reranker.scoreBatch(query, docs);
  } catch {
    return []; // soft-fail: a broken reranker never kills recall
  }
  const top = pool
    .map((t, i) => ({ t, s: scores[i] ?? -Infinity }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(x => x.t);

  // ── ±1 dialogue-neighbor expansion ───────────────────────────────────
  const keptById = new Map<number, FrameRow>();
  const convMaps = new Map<string, Map<number, FrameRow>>();
  for (const t of top) {
    const h = parseRawTurnHeader(t.content);
    if (!h) continue;
    let turns = convMaps.get(h.conv);
    if (!turns) {
      turns = convTurnMap(db, h.conv);
      convMaps.set(h.conv, turns);
    }
    for (const d of [-1, 0, 1]) {
      const n = turns.get(h.turn + d);
      if (n && !excludeIds.has(n.id)) keptById.set(n.id, n);
    }
  }

  // ── Chronological render order (date, then conv, then turn) ─────────
  const hits: RawTurnHit[] = [];
  for (const r of keptById.values()) {
    const h = parseRawTurnHeader(r.content);
    if (!h) continue;
    hits.push({ ...r, conv: h.conv, turn: h.turn, speaker: h.speaker });
  }
  hits.sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at))
    || a.conv.localeCompare(b.conv)
    || a.turn - b.turn);
  return hits;
}

/**
 * `hive-mind-cli cognify` — extract entities and relations from recent
 * frames into the knowledge graph. High-quality extraction requires an
 * LLM, so this command is a deliberately small heuristic pass suitable
 * for a nightly cron: it walks new frames, pulls capitalized noun
 * phrases, normalizes them, and creates/updates KG entities. Callers
 * who want richer extraction should run the MCP `save_entity` tool
 * with an LLM-driven agent instead.
 *
 * Scoping (3b-1): cognify can run against personal mind (default), a
 * specific workspace via `--workspace=<id>`, or every workspace at
 * once via `--all-workspaces`. Watermarks are per-mind so each scope
 * tracks its own delta-only progress.
 *
 * Watermark (3a-3): persistent state at ~/.hive-mind/cognify.watermark
 * (personal) or ~/.hive-mind/workspaces/<id>/cognify.watermark (per
 * workspace) tracks the last successfully-processed frame id. Subsequent
 * runs only scan frames newer than that, dropping the post-tool-use 60s
 * full-DB rescan to delta-only. `--full-rescan` bypasses the watermark.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openPersonalMind, type CliEnv } from '../setup.js';
import {
  normalizeEntityName,
  MindDB,
  KnowledgeGraph,
  extractEntitiesViaLLM,
  type ExtractedEntity,
  type LlmExecutor,
} from '@hive-mind/core';

/** Per-mind watermark file path. */
function watermarkPath(mindKey: 'personal' | { workspaceId: string }): string {
  if (mindKey === 'personal') {
    return path.join(os.homedir(), '.hive-mind', 'cognify.watermark');
  }
  return path.join(os.homedir(), '.hive-mind', 'workspaces', mindKey.workspaceId, 'cognify.watermark');
}

function readWatermark(file: string): number {
  try {
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeWatermark(file: string, id: number): void {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(id), 'utf8');
  } catch {
    // Watermark write is best-effort. Failing here only costs an extra
    // re-scan next run, not data integrity. Silent on purpose.
  }
}

export type CognifyExtractor = 'heuristic' | 'llm';

export interface CognifyOptions {
  /**
   * Process frames with id > since. When undefined, defaults to the
   * persisted watermark from `~/.hive-mind/cognify.watermark` (or 0).
   * Pass `0` explicitly together with `fullRescan: true` to force re-scan.
   */
  since?: number;
  limit?: number;
  /**
   * When true, ignores the persisted watermark and starts from since (or 0).
   * Use for occasional reconciliation against the full corpus, or when
   * extraction heuristics change and you want to re-process old frames.
   */
  fullRescan?: boolean;
  /**
   * Workspace ID to cognify instead of personal mind. Mutually exclusive
   * with allWorkspaces. The workspace mind file must exist (typically
   * created on first save_memory to the workspace).
   */
  workspace?: string;
  /**
   * Run cognify on every registered workspace mind in sequence (after
   * personal if specified, or instead of personal). Each mind keeps its
   * own watermark — slow workspaces don't block faster ones.
   */
  allWorkspaces?: boolean;
  /**
   * Extraction strategy. 'heuristic' (default) is the regex pass; cheap,
   * noisy, no LLM dependency. 'llm' invokes claude -p (or Anthropic API)
   * to extract semantic entities with types (person, project, file,
   * decision, bug, tool, location, concept). Slower but produces
   * wiki-grade entities; 3b-2 unlocks 3c-1 wiki excerpts.
   */
  extractor?: CognifyExtractor;
  /** When extractor='llm': 'cc' (default, claude -p subprocess) or 'api'. */
  executor?: LlmExecutor;
  /** When extractor='llm' executor='api': Anthropic model id. */
  llmModel?: string;
  /** When extractor='llm': frames per LLM batch (default 5). */
  llmBatch?: number;
  env?: CliEnv;
}

export interface CognifyResult {
  framesScanned: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  lastFrameId: number;
  /** Optional per-mind breakdown when allWorkspaces is true. */
  perMind?: Array<{
    mind: string;
    framesScanned: number;
    entitiesCreated: number;
    entitiesUpdated: number;
    lastFrameId: number;
  }>;
}

// Heuristic: consecutive capitalised words with optional connectors.
// Deliberately conservative — we prefer to miss entities than to create noise.
const ENTITY_PATTERN = /\b([A-Z][a-zA-Z]+(?:\s+(?:de|of|&)\s+|\s+)[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/g;
const SIMPLE_ENTITY_PATTERN = /\b([A-Z][a-zA-Z]{2,})\b/g;

// Skip common sentence-starts, pronouns, dev jargon, and date tokens that
// the naive regex catches. Pre-tightening, the dominant noise sources were
// (1) acronyms — API, CLI, JSON, HTTP, MCP, SQL — handled by isLikelyAcronym,
// (2) single capitalized verbs at sentence/line start (Add, Update, Run),
// (3) weekday/month abbreviations from log lines and timestamps.
const STOP_TOKENS = new Set([
  // sentence-starts and pronouns
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'Why', 'How',
  'What', 'Who', 'Which', 'If', 'And', 'But', 'Or', 'So', 'For', 'Nor',
  'Yet', 'As', 'At', 'By', 'On', 'In', 'To', 'From', 'With', 'Without',
  'Into', 'Onto', 'Upon', 'Over', 'Under', 'Between', 'Among',
  // common verbs that get capitalized at sentence start, in API names,
  // commit messages, or log prefixes
  'Add', 'Remove', 'Set', 'Get', 'Update', 'Delete', 'Create', 'List',
  'Search', 'Find', 'Run', 'Build', 'Use', 'Make', 'Test', 'Check',
  'Read', 'Write', 'Edit', 'Save', 'Load', 'Open', 'Close', 'Start',
  'Stop', 'Show', 'Hide', 'Push', 'Pull', 'Fix', 'Done', 'Skip',
  'Wait', 'Try', 'Note', 'Warn', 'Info', 'Debug', 'Trace',
  'Todo', 'Fixme', 'Should', 'Could', 'Would', 'Must', 'Will', 'Shall',
  'Can', 'May', 'Might',
  // days
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  // months
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
  'Nov', 'Dec',
  'January', 'February', 'March', 'April', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]);

// All-caps tokens up to 6 chars are almost always acronyms (API, CLI, JSON,
// HTTP, MCP, SQL, AWS, GCP, URL, UUID). Treat as too-low-signal to surface
// as entities — they're typically formatting artefacts, not subjects.
function isLikelyAcronym(s: string): boolean {
  return /^[A-Z]+$/.test(s) && s.length <= 6;
}

// Optional escape hatch: HIVE_MIND_COGNIFY_NO_SINGLE_WORD=1 disables the
// single-word pass entirely so only multi-word phrases become entities.
// Use when even tightened single-word extraction is too noisy for your corpus.
function singleWordPassEnabled(): boolean {
  return process.env.HIVE_MIND_COGNIFY_NO_SINGLE_WORD !== '1';
}

function extractCandidateEntities(text: string): string[] {
  const seen = new Set<string>();

  // Multi-word candidates first (more specific — Project Alpha, Acme Corp).
  for (const match of text.matchAll(ENTITY_PATTERN)) {
    const candidate = match[1].trim();
    if (candidate.length >= 4) seen.add(candidate);
  }

  // Single-word candidates — apply expanded filters (or skip entirely
  // when the env-var escape hatch is set).
  if (!singleWordPassEnabled()) return [...seen];
  for (const match of text.matchAll(SIMPLE_ENTITY_PATTERN)) {
    const candidate = match[1].trim();
    if (candidate.length < 4) continue;
    if (STOP_TOKENS.has(candidate)) continue;
    if (isLikelyAcronym(candidate)) continue;
    seen.add(candidate);
  }

  return [...seen];
}

interface OnMindOptions {
  since?: number;
  limit?: number;
  fullRescan?: boolean;
  extractor?: CognifyExtractor;
  executor?: LlmExecutor;
  llmModel?: string;
  llmBatch?: number;
}

/**
 * Builds a Map<frame_id, Array<{name,type}>> from one bulk LLM call.
 * Heuristic path supplies its own per-frame extraction inline below.
 */
async function llmExtractForFrames(
  frames: ReadonlyArray<{ id: number; content: string }>,
  options: OnMindOptions,
): Promise<Map<number, ExtractedEntity[]>> {
  const result = new Map<number, ExtractedEntity[]>();
  if (frames.length === 0) return result;

  process.stderr.write(
    `[cognify] llm extracting from ${frames.length} frames (batch=${options.llmBatch ?? 5}, executor=${options.executor ?? 'cc'})…\n`,
  );

  const extracted = await extractEntitiesViaLLM(frames, {
    executor: options.executor ?? 'cc',
    batchSize: options.llmBatch,
    model: options.llmModel,
    onBatchComplete: ({ batchIndex, entitiesFound, framesProcessed }) => {
      process.stderr.write(
        `[cognify]   batch ${batchIndex + 1} done — ${entitiesFound} entities, ${framesProcessed}/${frames.length} frames processed\n`,
      );
    },
  });

  for (const e of extracted) {
    const list = result.get(e.frame_id) ?? [];
    list.push(e);
    result.set(e.frame_id, list);
  }
  return result;
}

/**
 * Internal helper: runs cognify against an already-open mind, with watermark
 * resolution scoped to that mind. Used by both the personal and per-workspace
 * paths so the dedup/insert logic stays in one place — only the entity
 * extraction strategy differs (heuristic regex vs. LLM JSONL).
 */
async function runCognifyOnMind(
  raw: ReturnType<MindDB['getDatabase']>,
  kg: KnowledgeGraph,
  watermarkFile: string,
  options: OnMindOptions,
): Promise<{ framesScanned: number; entitiesCreated: number; entitiesUpdated: number; lastFrameId: number }> {
  const usingWatermark = options.since === undefined && !options.fullRescan;
  const since = options.since ?? (options.fullRescan ? 0 : readWatermark(watermarkFile));
  const limit = options.limit ?? 500;
  const extractor: CognifyExtractor = options.extractor ?? 'heuristic';

  const frames = raw.prepare(
    'SELECT id, content FROM memory_frames WHERE id > ? ORDER BY id ASC LIMIT ?',
  ).all(since, limit) as { id: number; content: string }[];

  let entitiesCreated = 0;
  let entitiesUpdated = 0;
  let lastFrameId = since;

  // LLM path: one bulk extraction up-front, then per-frame dedup/insert below.
  // Heuristic path: per-frame regex pass inside the loop.
  const llmIndex: Map<number, ExtractedEntity[]> | null =
    extractor === 'llm' ? await llmExtractForFrames(frames, options) : null;

  for (const frame of frames) {
    lastFrameId = Math.max(lastFrameId, frame.id);

    // Each candidate is { name, type } — heuristic returns 'concept' for all,
    // LLM returns semantic types. The dedup/insert path is shared.
    const candidates: Array<{ name: string; type: string }> = llmIndex
      ? (llmIndex.get(frame.id) ?? []).map((e) => ({ name: e.name, type: e.type }))
      : extractCandidateEntities(frame.content).map((name) => ({ name, type: 'concept' }));

    // Source tag: distinguishes LLM-grade entities from heuristic noise so
    // wiki cleanup can drop one set without affecting the other.
    const sourceTag = extractor === 'llm' ? 'cognify-llm' : 'cognify';

    for (const cand of candidates) {
      const normalized = normalizeEntityName(cand.name);
      if (normalized.length < 3) continue;

      // Dedup by exact name match. Previously used searchEntities(name, 3)
      // which is a LIKE '%name%' fuzzy search — once enough entities share
      // a common prefix, the exact match drops out of top-3 and dedup
      // silently fails. findEntityByName is the indexed exact-name lookup.
      const existing = kg.findEntityByName(cand.name);

      if (existing) {
        const existingProps = safeParse(existing.properties);
        const seenCount = Number(existingProps.seen_count ?? 1) + 1;
        kg.updateEntity(existing.id, {
          properties: { ...existingProps, seen_count: seenCount },
        });
        entitiesUpdated++;
      } else {
        try {
          kg.createEntity(cand.type, cand.name, { seen_count: 1, source: sourceTag });
          entitiesCreated++;
        } catch { /* validation may reject — skip */ }
      }
    }
  }

  if (usingWatermark && lastFrameId > since) {
    writeWatermark(watermarkFile, lastFrameId);
  }

  return { framesScanned: frames.length, entitiesCreated, entitiesUpdated, lastFrameId };
}

export async function runCognify(options: CognifyOptions = {}): Promise<CognifyResult> {
  // 3b-1: Three modes. Pick exactly one. allWorkspaces wins if both are set.
  if (options.allWorkspaces) {
    return runCognifyAllWorkspaces(options);
  }
  if (options.workspace) {
    return runCognifyOnWorkspace(options.workspace, options);
  }
  return runCognifyOnPersonal(options);
}

async function runCognifyOnPersonal(options: CognifyOptions): Promise<CognifyResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;

  try {
    const r = await runCognifyOnMind(
      env.db.getDatabase(),
      env.kg,
      watermarkPath('personal'),
      {
        since: options.since,
        limit: options.limit,
        fullRescan: options.fullRescan,
        extractor: options.extractor,
        executor: options.executor,
        llmModel: options.llmModel,
        llmBatch: options.llmBatch,
      },
    );
    return r;
  } finally {
    close();
  }
}

async function runCognifyOnWorkspace(workspaceId: string, options: CognifyOptions): Promise<CognifyResult> {
  // Resolve the workspace mind path through WorkspaceManager so we use the
  // same data dir + path conventions as the rest of the system.
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  try {
    const wm = env.workspaces;
    const ws = wm.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    const mindPath = wm.getMindPath(workspaceId);
    if (!fs.existsSync(mindPath)) {
      throw new Error(`Workspace mind file missing: ${mindPath}. Save at least one memory to materialise it.`);
    }
    const wsDb = new MindDB(mindPath);
    try {
      const wsKg = new KnowledgeGraph(wsDb);
      return await runCognifyOnMind(
        wsDb.getDatabase(),
        wsKg,
        watermarkPath({ workspaceId }),
        {
        since: options.since,
        limit: options.limit,
        fullRescan: options.fullRescan,
        extractor: options.extractor,
        executor: options.executor,
        llmModel: options.llmModel,
        llmBatch: options.llmBatch,
      },
      );
    } finally {
      wsDb.close();
    }
  } finally {
    close();
  }
}

async function runCognifyAllWorkspaces(options: CognifyOptions): Promise<CognifyResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  try {
    // Run personal first (so its result gives the headline numbers), then
    // each workspace. perMind tracks per-DB stats; top-level fields are the
    // SUM so callers that don't care about scope still see meaningful totals.
    const personal = await runCognifyOnMind(
      env.db.getDatabase(),
      env.kg,
      watermarkPath('personal'),
      {
        since: options.since,
        limit: options.limit,
        fullRescan: options.fullRescan,
        extractor: options.extractor,
        executor: options.executor,
        llmModel: options.llmModel,
        llmBatch: options.llmBatch,
      },
    );
    const perMind: NonNullable<CognifyResult['perMind']> = [
      { mind: 'personal', ...personal },
    ];

    let totalScanned = personal.framesScanned;
    let totalCreated = personal.entitiesCreated;
    let totalUpdated = personal.entitiesUpdated;
    let maxLastId = personal.lastFrameId;

    for (const ws of env.workspaces.list()) {
      const mindPath = env.workspaces.getMindPath(ws.id);
      if (!fs.existsSync(mindPath)) continue;
      try {
        const wsDb = new MindDB(mindPath);
        try {
          const wsKg = new KnowledgeGraph(wsDb);
          const r = await runCognifyOnMind(
            wsDb.getDatabase(),
            wsKg,
            watermarkPath({ workspaceId: ws.id }),
            {
        since: options.since,
        limit: options.limit,
        fullRescan: options.fullRescan,
        extractor: options.extractor,
        executor: options.executor,
        llmModel: options.llmModel,
        llmBatch: options.llmBatch,
      },
          );
          perMind.push({ mind: ws.id, ...r });
          totalScanned += r.framesScanned;
          totalCreated += r.entitiesCreated;
          totalUpdated += r.entitiesUpdated;
          maxLastId = Math.max(maxLastId, r.lastFrameId);
        } finally {
          wsDb.close();
        }
      } catch (err) {
        // One bad workspace mind shouldn't abort the rest. Surface the
        // failure as a perMind entry with zero counts and continue.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[cognify] workspace ${ws.id} failed: ${msg}\n`);
        perMind.push({ mind: ws.id, framesScanned: 0, entitiesCreated: 0, entitiesUpdated: 0, lastFrameId: 0 });
      }
    }

    return {
      framesScanned: totalScanned,
      entitiesCreated: totalCreated,
      entitiesUpdated: totalUpdated,
      lastFrameId: maxLastId,
      perMind,
    };
  } finally {
    close();
  }
}

function safeParse(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

/**
 * FrameStore — I/P/B memory-frame primitives backed by SQLite.
 *
 * The memory substrate models every stored observation as a `memory_frame` of
 * one of three types:
 *   I — an Independent frame: a fresh assertion about the world.
 *   P — a Partial update: a delta applied on top of a base I-frame.
 *   B — a Bridge frame: cross-links one frame to a set of others (references).
 *
 * Frames are grouped under a `gop_id` (Group Of Perception) and ordered by a
 * monotonically-increasing `t` within that group. The FTS5 virtual table
 * `memory_frames_fts` and the sqlite-vec `memory_frames_vec` table are kept in
 * sync by this module on insert / update / delete.
 *
 * Extracted from Waggle OS `packages/core/src/mind/frames.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import type { MindDB } from './db.js';
import { hashFrameContent, stripHmPrefix } from './content-hash.js';

// Re-export — stripHmPrefix lives in content-hash.ts so the hash and the strip
// stay in one module; existing importers keep working unchanged.
// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
export { stripHmPrefix };

/** Strict ISO-8601 check used by `createIFrame` to decide whether to honor
 *  a caller-supplied `createdAt`. Requires the `T` separator and a
 *  timezone suffix (`Z` or `±HH:MM`) — anything looser is high-risk for
 *  range queries on `memory_frames.created_at`. */
function isValidIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export type FrameType = 'I' | 'P' | 'B';
export type Importance = 'critical' | 'important' | 'normal' | 'temporary' | 'deprecated';
export type FrameSource =
  | 'user_stated'
  | 'tool_verified'
  | 'agent_inferred'
  | 'import'
  | 'system'
  | 'personal'
  | 'workspace'
  | 'team_sync';

export interface MemoryFrame {
  id: number;
  frame_type: FrameType;
  gop_id: string;
  t: number;
  base_frame_id: number | null;
  content: string;
  importance: Importance;
  source: FrameSource;
  access_count: number;
  created_at: string;
  last_accessed: string;
  /** JSON blob for per-frame provenance/classification metadata. Always present
   *  at the column level (NOT NULL DEFAULT '{}'); typed optional so pre-migration
   *  callers and literal constructions stay back-compatible. */
  metadata?: string;
}

export interface ReconstructedState {
  iframe: MemoryFrame | null;
  pframes: MemoryFrame[];
}

const IMPORTANCE_MULTIPLIERS: Record<Importance, number> = {
  critical: 2.0,
  important: 1.5,
  normal: 1.0,
  temporary: 0.7,
  deprecated: 0.3,
};

export class FrameStore {
  private db: MindDB;

  constructor(db: MindDB) {
    this.db = db;
  }

  createIFrame(
    gopId: string,
    content: string,
    importance: Importance = 'normal',
    source: FrameSource = 'user_stated',
    /** Optional override for `memory_frames.created_at`. Supplied by the harvest
     *  path so frames ingested from an export preserve the original source
     *  timestamp (e.g. Claude session `create_time`) instead of getting
     *  stamped with the ingest wall-clock. Callers that don't care about
     *  temporal-anchor preservation (live agent writes, cognify, etc.)
     *  should omit this argument and let the `datetime('now')` default apply.
     *
     *  Value must be a valid ISO-8601 string; invalid / null / undefined
     *  falls back to the schema default. The harvest-local caller is
     *  responsible for validating + logging the fallback path — we keep
     *  this function minimal and side-effect-free. */
    createdAt?: string | null,
  ): MemoryFrame {
    // L1: Dedup — if identical content exists, update access count instead of duplicating.
    const existing = this.findDuplicate(content);
    if (existing) return existing;

    const t = this.nextT(gopId);
    const raw = this.db.getDatabase();
    // Branch on whether the caller supplied a valid createdAt. We require
    // the strict ISO-8601 shape `YYYY-MM-DDT…Z` — anything else falls back
    // to the schema default (datetime('now')) to avoid writing junk
    // timestamps that break range queries. `last_accessed` mirrors
    // `created_at` on initial insert for consistency.
    const useProvidedTs = typeof createdAt === 'string' && isValidIsoTimestamp(createdAt);
    const contentHash = hashFrameContent(content);
    const result = useProvidedTs
      ? raw
          .prepare(
            `INSERT INTO memory_frames (frame_type, gop_id, t, base_frame_id, content, importance, source, created_at, last_accessed, content_hash)
             VALUES ('I', ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          )
          .run(gopId, t, content, importance, source, createdAt, createdAt, contentHash)
      : raw
          .prepare(
            `INSERT INTO memory_frames (frame_type, gop_id, t, base_frame_id, content, importance, source, content_hash)
             VALUES ('I', ?, ?, NULL, ?, ?, ?, ?)`,
          )
          .run(gopId, t, content, importance, source, contentHash);

    const frame = raw
      .prepare('SELECT * FROM memory_frames WHERE id = ?')
      .get(result.lastInsertRowid) as MemoryFrame;
    this.indexFts(frame);
    return frame;
  }

  createPFrame(
    gopId: string,
    content: string,
    baseFrameId: number,
    importance: Importance = 'normal',
    source: FrameSource = 'user_stated',
  ): MemoryFrame {
    const t = this.nextT(gopId);
    const raw = this.db.getDatabase();
    const result = raw
      .prepare(
        `INSERT INTO memory_frames (frame_type, gop_id, t, base_frame_id, content, importance, source, content_hash)
         VALUES ('P', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(gopId, t, baseFrameId, content, importance, source, hashFrameContent(content));

    const frame = raw
      .prepare('SELECT * FROM memory_frames WHERE id = ?')
      .get(result.lastInsertRowid) as MemoryFrame;
    this.indexFts(frame);
    return frame;
  }

  createBFrame(
    gopId: string,
    content: string,
    baseFrameId: number,
    referencedFrameIds: number[],
  ): MemoryFrame {
    const t = this.nextT(gopId);
    const bContent = JSON.stringify({
      description: content,
      references: referencedFrameIds,
    });
    const raw = this.db.getDatabase();
    const result = raw
      .prepare(
        `INSERT INTO memory_frames (frame_type, gop_id, t, base_frame_id, content, importance, content_hash)
         VALUES ('B', ?, ?, ?, ?, 'normal', ?)`,
      )
      .run(gopId, t, baseFrameId, bContent, hashFrameContent(bContent));

    const frame = raw
      .prepare('SELECT * FROM memory_frames WHERE id = ?')
      .get(result.lastInsertRowid) as MemoryFrame;
    this.indexFts(frame);
    return frame;
  }

  getById(id: number): MemoryFrame | undefined {
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM memory_frames WHERE id = ?')
      .get(id) as MemoryFrame | undefined;
  }

  getLatestIFrame(gopId: string): MemoryFrame | undefined {
    return this.db
      .getDatabase()
      .prepare(
        `SELECT * FROM memory_frames
         WHERE gop_id = ? AND frame_type = 'I'
         ORDER BY t DESC LIMIT 1`,
      )
      .get(gopId) as MemoryFrame | undefined;
  }

  getPFramesSinceLastI(gopId: string): MemoryFrame[] {
    const latestI = this.getLatestIFrame(gopId);
    if (!latestI) return [];
    return this.db
      .getDatabase()
      .prepare(
        `SELECT * FROM memory_frames
         WHERE gop_id = ? AND frame_type = 'P' AND t > ?
         ORDER BY t ASC`,
      )
      .all(gopId, latestI.t) as MemoryFrame[];
  }

  getGopFrames(gopId: string): MemoryFrame[] {
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM memory_frames WHERE gop_id = ? ORDER BY t ASC')
      .all(gopId) as MemoryFrame[];
  }

  reconstructState(gopId: string): ReconstructedState {
    const iframe = this.getLatestIFrame(gopId) ?? null;
    const pframes = iframe ? this.getPFramesSinceLastI(gopId) : [];
    return { iframe, pframes };
  }

  /** Bump access_count + last_accessed. Returns the new access_count, or
   *  undefined when the id is unknown.
   *  Forward-ported from waggle-os monorepo (mono-parity 2026-06-12). */
  touch(id: number): number | undefined {
    const row = this.db
      .getDatabase()
      .prepare(
        `UPDATE memory_frames SET access_count = access_count + 1, last_accessed = datetime('now')
         WHERE id = ?
         RETURNING access_count AS accessCount`,
      )
      .get(id) as { accessCount: number } | undefined;
    return row?.accessCount;
  }

  getImportanceMultiplier(importance: Importance): number {
    return IMPORTANCE_MULTIPLIERS[importance];
  }

  /** List frames with an options bag (convenience wrapper). */
  list(opts: { limit?: number } = {}): MemoryFrame[] {
    return this.getRecent(opts.limit ?? 50);
  }

  /** Get the most recent frames ordered by creation time descending. */
  getRecent(limit = 50): MemoryFrame[] {
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM memory_frames ORDER BY id DESC LIMIT ?')
      .all(limit) as MemoryFrame[];
  }

  /**
   * Get recent frames with optional temporal boundaries.
   * @param limit Maximum number of results
   * @param since Only include frames created on or after this ISO date string
   * @param until Only include frames created on or before this ISO date string
   */
  getRecentFiltered(limit = 50, since?: string, until?: string): MemoryFrame[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (since) {
      conditions.push('created_at >= ?');
      params.push(since);
    }
    if (until) {
      conditions.push('created_at <= ?');
      params.push(until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    return this.db
      .getDatabase()
      .prepare(`SELECT * FROM memory_frames ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as MemoryFrame[];
  }

  getBFrameReferences(bframeId: number): number[] {
    const frame = this.getById(bframeId);
    if (!frame || frame.frame_type !== 'B') return [];
    try {
      const parsed = JSON.parse(frame.content);
      return parsed.references ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Check for duplicate content before inserting.
   * Returns the existing frame if content hash matches, null otherwise.
   * If a duplicate is found, updates its access_count instead of creating a new frame.
   *
   * Comparison matches on the indexed `content_hash` column (hashFrameContent):
   *  - trim-stable: JS `trim()` over the content (SQLite's `trim()` only
   *    strips ASCII space, so hashing happens JS-side, never in SQL);
   *  - provenance-insensitive: content passes through `stripHmPrefix` before
   *    hashing, so two same-body captures of one turn collapse into one frame
   *    regardless of which source's `[hm …]` prefix they carry.
   *    (Forward-ported from waggle-os monorepo, mono-parity 2026-06-12.)
   * `ORDER BY id DESC LIMIT 1` preserves the legacy "most-recent match wins"
   * semantics; the lookup is global (no gop_id scope), matching the prior
   * unbounded-scan behavior but without the 500-row recency cap.
   */
  findDuplicate(content: string): MemoryFrame | null {
    const hash = hashFrameContent(content);
    const frame = this.db
      .getDatabase()
      .prepare('SELECT * FROM memory_frames WHERE content_hash = ? ORDER BY id DESC LIMIT 1')
      .get(hash) as MemoryFrame | undefined;

    if (frame) {
      this.touch(frame.id);
      return frame;
    }
    return null;
  }

  /**
   * Update a frame's content and/or importance by ID.
   * Updates the main table, FTS index, and vector index.
   * Returns the updated frame, or undefined if not found.
   */
  update(id: number, content: string, importance?: Importance): MemoryFrame | undefined {
    const raw = this.db.getDatabase();
    const existing = this.getById(id);
    if (!existing) return undefined;

    const newImportance = importance ?? existing.importance;

    raw
      .prepare('UPDATE memory_frames SET content = ?, importance = ?, content_hash = ? WHERE id = ?')
      .run(content, newImportance, hashFrameContent(content), id);

    raw.prepare('DELETE FROM memory_frames_fts WHERE rowid = ?').run(id);
    raw.prepare('INSERT INTO memory_frames_fts (rowid, content) VALUES (?, ?)').run(id, content);

    try {
      raw.prepare('DELETE FROM memory_frames_vec WHERE rowid = ?').run(id);
    } catch {
      /* vec table may not exist */
    }

    return this.getById(id);
  }

  /**
   * Replace a frame's `metadata` JSON blob (provenance/classification metadata).
   * Low-level writer — the caller passes a fully-formed JSON string; parse/merge
   * semantics live in the caller. Does NOT touch FTS/vector indexes (metadata is
   * not full-text searchable). Returns the updated frame, or undefined if the id
   * is unknown.
   */
  setMetadata(id: number, metadata: string): MemoryFrame | undefined {
    const raw = this.db.getDatabase();
    if (!this.getById(id)) return undefined;
    raw.prepare('UPDATE memory_frames SET metadata = ? WHERE id = ?').run(metadata, id);
    return this.getById(id);
  }

  /** Delete a frame by ID. Returns true if deleted, false if not found. */
  delete(id: number): boolean {
    const raw = this.db.getDatabase();
    raw
      .prepare('UPDATE memory_frames SET base_frame_id = NULL WHERE base_frame_id = ?')
      .run(id);
    try {
      raw.prepare('DELETE FROM memory_frames_vec WHERE rowid = ?').run(id);
    } catch {
      /* vec table may not exist */
    }
    raw.prepare('DELETE FROM memory_frames_fts WHERE rowid = ?').run(id);
    try {
      raw.prepare('DELETE FROM kg_entity_frames WHERE frame_id = ?').run(id);
    } catch {
      /* KG tables may not exist */
    }
    const result = raw.prepare('DELETE FROM memory_frames WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Delete every frame whose content starts with `prefix` (exact literal
   * match — LIKE metacharacters in the prefix are escaped). Used by
   * replace-on-update lanes (e.g. a profile card supersedes the prior card
   * for the same subject). Routes through delete(id) so FTS/vec/KG cleanup
   * applies. Returns the number of frames deleted.
   * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
   */
  deleteByContentPrefix(prefix: string): number {
    const raw = this.db.getDatabase();
    const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = raw
      .prepare(`SELECT id FROM memory_frames WHERE content LIKE ? ESCAPE '\\'`)
      .all(`${escaped}%`) as Array<{ id: number }>;
    let deleted = 0;
    for (const r of rows) {
      if (this.delete(r.id)) deleted++;
    }
    return deleted;
  }

  // ── Memory Compaction ──────────────────────────────────────────────────

  /**
   * Compact memory: merge stale P-frames into their base I-frame, prune
   * deprecated frames, and clean up temporary frames older than maxAge.
   *
   * @param maxTempAgeDays Delete temporary frames older than this (default 30)
   * @param maxDeprecatedAgeDays Delete deprecated frames older than this (default 90)
   * @returns Summary of compaction actions taken
   */
  compact(
    maxTempAgeDays = 30,
    maxDeprecatedAgeDays = 90,
  ): { temporaryPruned: number; deprecatedPruned: number; pframesMerged: number } {
    const raw = this.db.getDatabase();
    let pframesMerged = 0;

    const tempResult = raw
      .prepare(
        `DELETE FROM memory_frames
         WHERE importance = 'temporary'
           AND created_at < datetime('now', '-' || ? || ' days')`,
      )
      .run(maxTempAgeDays);
    const temporaryPruned = tempResult.changes;

    const depResult = raw
      .prepare(
        `DELETE FROM memory_frames
         WHERE importance = 'deprecated'
           AND created_at < datetime('now', '-' || ? || ' days')`,
      )
      .run(maxDeprecatedAgeDays);
    const deprecatedPruned = depResult.changes;

    const gopsWithManyPframes = raw
      .prepare(
        `SELECT gop_id, COUNT(*) as cnt FROM memory_frames
         WHERE frame_type = 'P'
         GROUP BY gop_id
         HAVING cnt > 10`,
      )
      .all() as { gop_id: string; cnt: number }[];

    for (const { gop_id } of gopsWithManyPframes) {
      const latestI = this.getLatestIFrame(gop_id);
      if (!latestI) continue;

      const pframes = raw
        .prepare(
          `SELECT * FROM memory_frames
           WHERE gop_id = ? AND frame_type = 'P' AND t > ?
           ORDER BY t ASC`,
        )
        .all(gop_id, latestI.t) as MemoryFrame[];

      if (pframes.length <= 10) continue;

      // Keep the 5 most recent P-frames, merge the rest into the I-frame.
      const toMerge = pframes.slice(0, pframes.length - 5);
      const mergedContent = [latestI.content, ...toMerge.map((p) => p.content)].join('\n---\n');

      raw
        .prepare('UPDATE memory_frames SET content = ?, content_hash = ? WHERE id = ?')
        .run(mergedContent, hashFrameContent(mergedContent), latestI.id);
      raw.prepare('DELETE FROM memory_frames_fts WHERE rowid = ?').run(latestI.id);
      raw
        .prepare('INSERT INTO memory_frames_fts (rowid, content) VALUES (?, ?)')
        .run(latestI.id, mergedContent);

      for (const pf of toMerge) {
        raw.prepare('DELETE FROM memory_frames_fts WHERE rowid = ?').run(pf.id);
        try {
          raw.prepare('DELETE FROM memory_frames_vec WHERE rowid = ?').run(pf.id);
        } catch {
          /* vec table may not exist */
        }
        raw.prepare('DELETE FROM memory_frames WHERE id = ?').run(pf.id);
        pframesMerged++;
      }
    }

    return { temporaryPruned, deprecatedPruned, pframesMerged };
  }

  /** Get frame statistics for monitoring. */
  getStats(): {
    total: number;
    byType: Record<string, number>;
    byImportance: Record<string, number>;
  } {
    const raw = this.db.getDatabase();
    const total = (raw.prepare('SELECT COUNT(*) as cnt FROM memory_frames').get() as {
      cnt: number;
    }).cnt;

    const byType: Record<string, number> = {};
    for (const row of raw
      .prepare('SELECT frame_type, COUNT(*) as cnt FROM memory_frames GROUP BY frame_type')
      .all() as { frame_type: string; cnt: number }[]) {
      byType[row.frame_type] = row.cnt;
    }

    const byImportance: Record<string, number> = {};
    for (const row of raw
      .prepare('SELECT importance, COUNT(*) as cnt FROM memory_frames GROUP BY importance')
      .all() as { importance: string; cnt: number }[]) {
      byImportance[row.importance] = row.cnt;
    }

    return { total, byType, byImportance };
  }

  private nextT(gopId: string): number {
    const row = this.db
      .getDatabase()
      .prepare('SELECT COALESCE(MAX(t), -1) + 1 AS next_t FROM memory_frames WHERE gop_id = ?')
      .get(gopId) as { next_t: number };
    return row.next_t;
  }

  private indexFts(frame: MemoryFrame): void {
    this.db
      .getDatabase()
      .prepare('INSERT INTO memory_frames_fts (rowid, content) VALUES (?, ?)')
      .run(frame.id, frame.content);
  }
}

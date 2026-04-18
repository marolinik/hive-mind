/**
 * Index reconciliation — repair FTS5 and sqlite-vec indexes after crashes.
 *
 * If the process dies between creating a memory frame and writing its FTS5 /
 * vector entries, the frame exists but isn't searchable. These helpers find
 * those orphans and re-index them, and sweep the other direction too
 * (FTS/vec entries whose frame has been deleted).
 *
 * All functions are idempotent — safe to run as a periodic maintenance job.
 * `reconcileVecIndex` and `cleanOrphanVectors` gracefully no-op when the
 * sqlite-vec `memory_frames_vec` table is absent (e.g. if the consumer
 * disabled vector search).
 *
 * Extracted from Waggle OS `packages/core/src/mind/reconcile.ts`.
 * Scrub: none — this module has no proprietary dependencies. Internal
 * feature-number comment prefix (`9b:`) dropped as noise.
 */

import type { MindDB } from './db.js';
import type { Embedder } from './embeddings.js';

export interface ReconcileResult {
  ftsFixed: number;
  vecFixed: number;
}

/**
 * Find frames missing from FTS5 and re-index them.
 * Does NOT require an embedder — operates only on the FTS5 table.
 */
export function reconcileFtsIndex(db: MindDB): number {
  const raw = db.getDatabase();

  const missingFts = raw
    .prepare(
      `SELECT f.id, f.content FROM memory_frames f
       WHERE f.id NOT IN (SELECT rowid FROM memory_frames_fts)`,
    )
    .all() as { id: number; content: string }[];

  if (missingFts.length === 0) return 0;

  const insertFts = raw.prepare(
    'INSERT INTO memory_frames_fts (rowid, content) VALUES (?, ?)',
  );

  const insertAll = raw.transaction(() => {
    for (const row of missingFts) {
      insertFts.run(row.id, row.content);
    }
  });
  insertAll();

  return missingFts.length;
}

/**
 * Find frames missing from the vector index and re-index them.
 * Requires an embedder to compute embeddings for the missing frames.
 * Returns 0 if the vec table doesn't exist.
 */
export async function reconcileVecIndex(db: MindDB, embedder: Embedder): Promise<number> {
  const raw = db.getDatabase();

  const vecExists = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_frames_vec'")
    .get();
  if (!vecExists) return 0;

  const missingVec = raw
    .prepare(
      `SELECT f.id, f.content FROM memory_frames f
       WHERE f.id NOT IN (SELECT rowid FROM memory_frames_vec)`,
    )
    .all() as { id: number; content: string }[];

  if (missingVec.length === 0) return 0;

  // Embed in batches to avoid memory pressure.
  const BATCH_SIZE = 50;
  for (let i = 0; i < missingVec.length; i += BATCH_SIZE) {
    const batch = missingVec.slice(i, i + BATCH_SIZE);
    const contents = batch.map((r) => r.content);
    const embeddings = await embedder.embedBatch(contents);

    const insertBatch = raw.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        // sqlite-vec vec0 requires rowid as SQL literal on INSERT — parameterized
        // rowid isn't supported. Math.trunc guards against floating-point ids.
        const id = Math.trunc(batch[j].id);
        const blob = new Uint8Array(
          embeddings[j].buffer,
          embeddings[j].byteOffset,
          embeddings[j].byteLength,
        );
        raw
          .prepare(`INSERT INTO memory_frames_vec (rowid, embedding) VALUES (${id}, ?)`)
          .run(blob);
      }
    });
    insertBatch();
  }

  return missingVec.length;
}

/** Remove orphan vector entries — vectors whose frame has been deleted. */
export function cleanOrphanVectors(db: MindDB): number {
  const raw = db.getDatabase();

  const vecExists = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_frames_vec'")
    .get();
  if (!vecExists) return 0;

  const orphans = raw
    .prepare(
      `SELECT v.rowid FROM memory_frames_vec v
       WHERE v.rowid NOT IN (SELECT id FROM memory_frames)`,
    )
    .all() as { rowid: number }[];

  if (orphans.length === 0) return 0;

  const deleteTx = raw.transaction(() => {
    for (const { rowid } of orphans) {
      raw.prepare('DELETE FROM memory_frames_vec WHERE rowid = ?').run(rowid);
    }
  });
  deleteTx();

  return orphans.length;
}

/** Remove orphan FTS entries — FTS entries whose frame has been deleted. */
export function cleanOrphanFts(db: MindDB): number {
  const raw = db.getDatabase();

  const orphans = raw
    .prepare(
      `SELECT rowid FROM memory_frames_fts
       WHERE rowid NOT IN (SELECT id FROM memory_frames)`,
    )
    .all() as { rowid: number }[];

  if (orphans.length === 0) return 0;

  const deleteTx = raw.transaction(() => {
    for (const { rowid } of orphans) {
      raw.prepare('DELETE FROM memory_frames_fts WHERE rowid = ?').run(rowid);
    }
  });
  deleteTx();

  return orphans.length;
}

/**
 * Full reconciliation: repair both FTS5 and vector indexes, then sweep
 * orphan entries. If no embedder is provided, only FTS5 is reconciled.
 */
export async function reconcileIndexes(
  db: MindDB,
  embedder?: Embedder,
): Promise<ReconcileResult> {
  const ftsFixed = reconcileFtsIndex(db);
  const vecFixed = embedder ? await reconcileVecIndex(db, embedder) : 0;

  cleanOrphanFts(db);
  cleanOrphanVectors(db);

  return { ftsFixed, vecFixed };
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB } from './db.js';
import { FrameStore } from './frames.js';
import {
  reconcileFtsIndex,
  reconcileVecIndex,
  cleanOrphanFts,
  cleanOrphanVectors,
  reconcileIndexes,
} from './reconcile.js';
import { createEmbeddingProvider, type EmbeddingProviderInstance } from './embedding-provider.js';

describe('reconcile', () => {
  let dbPath: string;
  let db: MindDB;
  let frames: FrameStore;
  let embedder: EmbeddingProviderInstance;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `hive-mind-reconcile-test-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    db.getDatabase()
      .prepare(
        "INSERT INTO sessions (gop_id, status, started_at) VALUES ('gop-recon', 'active', datetime('now'))",
      )
      .run();
    frames = new FrameStore(db);
    embedder = await createEmbeddingProvider({ provider: 'mock' });
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  /** Insert a frame directly into memory_frames WITHOUT touching FTS5 or vec —
   *  simulates the crash state where indexing didn't complete. */
  function insertRawFrame(content: string): number {
    const result = db
      .getDatabase()
      .prepare(
        `INSERT INTO memory_frames (frame_type, gop_id, t, content, importance)
         VALUES ('I', 'gop-recon', (SELECT COALESCE(MAX(t), -1) + 1 FROM memory_frames WHERE gop_id = 'gop-recon'), ?, 'normal')`,
      )
      .run(content);
    return result.lastInsertRowid as number;
  }

  function ftsCount(): number {
    return (
      db.getDatabase().prepare('SELECT COUNT(*) as n FROM memory_frames_fts').get() as {
        n: number;
      }
    ).n;
  }

  function vecCount(): number {
    return (
      db.getDatabase().prepare('SELECT COUNT(*) as n FROM memory_frames_vec').get() as {
        n: number;
      }
    ).n;
  }

  describe('reconcileFtsIndex', () => {
    it('re-indexes frames missing from FTS5', () => {
      const a = insertRawFrame('lost frame one');
      const b = insertRawFrame('lost frame two');
      expect(ftsCount()).toBe(0);

      const fixed = reconcileFtsIndex(db);
      expect(fixed).toBe(2);
      expect(ftsCount()).toBe(2);

      // Confirm the repaired entries are searchable.
      const hits = db
        .getDatabase()
        .prepare('SELECT rowid FROM memory_frames_fts WHERE content MATCH ?')
        .all('"lost"') as { rowid: number }[];
      expect(hits.map((h) => h.rowid).sort()).toEqual([a, b].sort());
    });

    it('no-ops and returns 0 when FTS5 is already in sync', () => {
      frames.createIFrame('gop-recon', 'indexed normally');
      expect(ftsCount()).toBe(1);

      expect(reconcileFtsIndex(db)).toBe(0);
      expect(ftsCount()).toBe(1);
    });

    it('is idempotent across repeated calls', () => {
      insertRawFrame('x');
      expect(reconcileFtsIndex(db)).toBe(1);
      expect(reconcileFtsIndex(db)).toBe(0);
      expect(reconcileFtsIndex(db)).toBe(0);
    });
  });

  describe('reconcileVecIndex', () => {
    it('re-indexes frames missing from the vector table using the embedder', async () => {
      frames.createIFrame('gop-recon', 'frame with no vec entry yet');
      expect(vecCount()).toBe(0);

      const fixed = await reconcileVecIndex(db, embedder);
      expect(fixed).toBe(1);
      expect(vecCount()).toBe(1);
    });

    it('no-ops when every frame is already vec-indexed', async () => {
      const frame = frames.createIFrame('gop-recon', 'pre-indexed');
      // Manually insert a vec entry to simulate the already-indexed state.
      const embedding = await embedder.embed(frame.content);
      const blob = new Uint8Array(
        embedding.buffer,
        embedding.byteOffset,
        embedding.byteLength,
      );
      db.getDatabase()
        .prepare(
          `INSERT INTO memory_frames_vec (rowid, embedding) VALUES (${frame.id}, ?)`,
        )
        .run(blob);
      expect(vecCount()).toBe(1);

      const fixed = await reconcileVecIndex(db, embedder);
      expect(fixed).toBe(0);
      expect(vecCount()).toBe(1);
    });

    it('batches large backlogs without exceeding the hard-coded BATCH_SIZE', async () => {
      // Insert 75 frames with no vec entries to cross the 50-row batch boundary.
      for (let i = 0; i < 75; i++) {
        insertRawFrame(`batch content ${i}`);
      }
      const fixed = await reconcileVecIndex(db, embedder);
      expect(fixed).toBe(75);
      expect(vecCount()).toBe(75);
    });
  });

  describe('cleanOrphanFts', () => {
    it('removes FTS entries whose frame has been deleted out-of-band', () => {
      const frame = frames.createIFrame('gop-recon', 'soon orphan');
      expect(ftsCount()).toBe(1);

      // Delete directly from memory_frames to bypass FrameStore.delete()'s cleanup.
      db.getDatabase().prepare('DELETE FROM memory_frames WHERE id = ?').run(frame.id);
      expect(ftsCount()).toBe(1); // FTS still has the orphan.

      const removed = cleanOrphanFts(db);
      expect(removed).toBe(1);
      expect(ftsCount()).toBe(0);
    });

    it('returns 0 when there are no orphans', () => {
      frames.createIFrame('gop-recon', 'healthy');
      expect(cleanOrphanFts(db)).toBe(0);
    });
  });

  describe('cleanOrphanVectors', () => {
    it('removes vec entries whose frame has been deleted out-of-band', async () => {
      const frame = frames.createIFrame('gop-recon', 'vec orphan incoming');
      const embedding = await embedder.embed(frame.content);
      const blob = new Uint8Array(
        embedding.buffer,
        embedding.byteOffset,
        embedding.byteLength,
      );
      db.getDatabase()
        .prepare(
          `INSERT INTO memory_frames_vec (rowid, embedding) VALUES (${frame.id}, ?)`,
        )
        .run(blob);
      expect(vecCount()).toBe(1);

      // Bypass FrameStore.delete() to leave the vec entry dangling.
      db.getDatabase().prepare('DELETE FROM memory_frames WHERE id = ?').run(frame.id);

      const removed = cleanOrphanVectors(db);
      expect(removed).toBe(1);
      expect(vecCount()).toBe(0);
    });
  });

  describe('reconcileIndexes', () => {
    it('repairs FTS5 and vec together when an embedder is provided', async () => {
      insertRawFrame('needs fts and vec');

      const result = await reconcileIndexes(db, embedder);
      expect(result.ftsFixed).toBe(1);
      expect(result.vecFixed).toBe(1);
      expect(ftsCount()).toBe(1);
      expect(vecCount()).toBe(1);
    });

    it('skips vec reconciliation when no embedder is supplied', async () => {
      insertRawFrame('fts only');

      const result = await reconcileIndexes(db);
      expect(result.ftsFixed).toBe(1);
      expect(result.vecFixed).toBe(0);
      expect(ftsCount()).toBe(1);
      expect(vecCount()).toBe(0);
    });

    it('sweeps orphans in the same pass', async () => {
      // Create a healthy frame, then orphan it out-of-band.
      const frame = frames.createIFrame('gop-recon', 'about to be orphaned');
      const embedding = await embedder.embed(frame.content);
      const blob = new Uint8Array(
        embedding.buffer,
        embedding.byteOffset,
        embedding.byteLength,
      );
      db.getDatabase()
        .prepare(
          `INSERT INTO memory_frames_vec (rowid, embedding) VALUES (${frame.id}, ?)`,
        )
        .run(blob);
      db.getDatabase().prepare('DELETE FROM memory_frames WHERE id = ?').run(frame.id);

      await reconcileIndexes(db, embedder);
      expect(ftsCount()).toBe(0);
      expect(vecCount()).toBe(0);
    });
  });
});

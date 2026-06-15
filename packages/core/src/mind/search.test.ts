import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB, EmbeddingDimMismatchError } from './db.js';
import { FrameStore } from './frames.js';
import {
  HybridSearch,
  assessRetrievalConfidence,
  chunkRetrievalEnabled,
  rechunkAllFrames,
  type SearchResult,
} from './search.js';
import { createEmbeddingProvider, type EmbeddingProviderInstance } from './embedding-provider.js';
import type { Embedder } from './embeddings.js';

describe('HybridSearch', () => {
  let dbPath: string;
  let db: MindDB;
  let frames: FrameStore;
  let embedder: EmbeddingProviderInstance;
  let search: HybridSearch;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `hive-mind-search-test-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    db.getDatabase()
      .prepare(
        "INSERT INTO sessions (gop_id, status, started_at) VALUES ('gop-a', 'active', datetime('now'))",
      )
      .run();
    db.getDatabase()
      .prepare(
        "INSERT INTO sessions (gop_id, status, started_at) VALUES ('gop-b', 'active', datetime('now'))",
      )
      .run();
    frames = new FrameStore(db);
    embedder = await createEmbeddingProvider({ provider: 'mock' });
    search = new HybridSearch(db, embedder);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('keywordSearch finds frames containing the query terms', async () => {
    const a = frames.createIFrame('gop-a', 'user prefers TypeScript over JavaScript');
    frames.createIFrame('gop-a', 'user likes weekend hiking trips in the Alps');

    const ids = await search.keywordSearch('TypeScript preferences', 10);
    expect(ids).toContain(a.id);
  });

  it('keywordSearch scopes results to gopId when provided', async () => {
    const inA = frames.createIFrame('gop-a', 'deployment blueprint alpha');
    const inB = frames.createIFrame('gop-b', 'deployment blueprint bravo');

    const scopedToA = await search.keywordSearch('deployment blueprint', 10, 'gop-a');
    expect(scopedToA).toContain(inA.id);
    expect(scopedToA).not.toContain(inB.id);

    const scopedToB = await search.keywordSearch('deployment blueprint', 10, 'gop-b');
    expect(scopedToB).toContain(inB.id);
    expect(scopedToB).not.toContain(inA.id);
  });

  it('keywordSearch returns [] for queries containing only stop words', async () => {
    frames.createIFrame('gop-a', 'content that will not match a stop-word query');
    const ids = await search.keywordSearch('the a an of to in for on with', 10);
    expect(ids).toEqual([]);
  });

  it('indexFrame inserts into memory_frames_vec and vectorSearch retrieves it', async () => {
    const frame = frames.createIFrame('gop-a', 'quantum annealing implementation notes');
    await search.indexFrame(frame.id, frame.content);

    const count = db
      .getDatabase()
      .prepare('SELECT COUNT(*) as n FROM memory_frames_vec')
      .get() as { n: number };
    expect(count.n).toBe(1);

    const ids = await search.vectorSearch('quantum annealing implementation notes', 10);
    expect(ids).toContain(frame.id);
  });

  it('records the embedding fingerprint (provider + dim) on first vector write', async () => {
    const f = frames.createIFrame('gop-a', 'fingerprint this frame');
    await search.indexFrame(f.id, f.content);
    const raw = db.getDatabase();
    const dim = raw.prepare("SELECT value FROM meta WHERE key = 'embedding_dim'").get() as
      | { value: string }
      | undefined;
    const provider = raw.prepare("SELECT value FROM meta WHERE key = 'embedding_provider'").get() as
      | { value: string }
      | undefined;
    expect(dim?.value).toBe('1024'); // mock default
    expect(provider?.value).toBe('mock');
  });

  it('refuses index AND search when the embedder dim no longer matches the stored fingerprint', async () => {
    const f = frames.createIFrame('gop-a', 'seed written under the 1024-dim mock');
    await search.indexFrame(f.id, f.content); // records dim 1024

    // A different HybridSearch over the SAME db, but with a 768-dim embedder.
    const small: Embedder = {
      dimensions: 768,
      async embed() {
        return new Float32Array(768);
      },
      async embedBatch(texts) {
        return texts.map(() => new Float32Array(768));
      },
    };
    const search2 = new HybridSearch(db, small);
    const g = frames.createIFrame('gop-a', 'a frame we should never get to embed');
    await expect(search2.indexFrame(g.id, g.content)).rejects.toThrow(EmbeddingDimMismatchError);
    await expect(search2.vectorSearch('any query', 5)).rejects.toThrow(EmbeddingDimMismatchError);
  });

  it('indexFramesBatch inserts multiple rows atomically', async () => {
    const a = frames.createIFrame('gop-a', 'alpha content');
    const b = frames.createIFrame('gop-a', 'bravo content');
    const c = frames.createIFrame('gop-a', 'charlie content');

    await search.indexFramesBatch([
      { id: a.id, content: a.content },
      { id: b.id, content: b.content },
      { id: c.id, content: c.content },
    ]);

    const count = db
      .getDatabase()
      .prepare('SELECT COUNT(*) as n FROM memory_frames_vec')
      .get() as { n: number };
    expect(count.n).toBe(3);
  });

  it('search() fuses keyword + vector ranks and returns sorted SearchResults', async () => {
    const a = frames.createIFrame('gop-a', 'roadmap for Q2 launch', 'important');
    const b = frames.createIFrame('gop-a', 'Q2 launch success criteria', 'critical');
    const c = frames.createIFrame('gop-a', 'unrelated conversation about coffee');

    await search.indexFramesBatch([
      { id: a.id, content: a.content },
      { id: b.id, content: b.content },
      { id: c.id, content: c.content },
    ]);

    const results = await search.search('Q2 launch', { limit: 3 });
    expect(results.length).toBeGreaterThan(0);

    // Every result must have all three score fields populated and non-negative.
    for (const r of results) {
      expect(r.rrfScore).toBeGreaterThan(0);
      expect(r.relevanceScore).toBeGreaterThan(0);
      expect(r.finalScore).toBe(r.rrfScore * r.relevanceScore);
    }

    // Results must be sorted by finalScore descending.
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].finalScore).toBeGreaterThanOrEqual(results[i].finalScore);
    }

    // The two topic-matching frames should rank above the off-topic one.
    const topIds = results.map((r) => r.frame.id);
    expect(topIds).toContain(a.id);
    expect(topIds).toContain(b.id);
  });

  // ── Forward-ported from waggle-os monorepo (mono-parity 2026-06-12) ──────

  describe('since/until date-window fixes', () => {
    function setCreatedAt(frameId: number, createdAt: string): void {
      db.getDatabase()
        .prepare('UPDATE memory_frames SET created_at = ? WHERE id = ?')
        .run(createdAt, frameId);
    }

    it('fencepost: date-only until includes an ISO timestamp later on the until day', async () => {
      const f = frames.createIFrame('gop-a', 'quarterly metrics review for the launch');
      setCreatedAt(f.id, '2026-03-21T10:00:00.000Z'); // same day, after midnight

      const hits = await search.search('quarterly metrics review', {
        limit: 5,
        until: '2026-03-21',
      });
      expect(hits.map((h) => h.frame.id)).toContain(f.id);
    });

    it('fencepost: date-only until includes a space-separated timestamp on the until day', async () => {
      const f = frames.createIFrame('gop-a', 'quarterly metrics review for the launch');
      setCreatedAt(f.id, '2026-03-21 14:30:00'); // datetime('now') format

      const hits = await search.search('quarterly metrics review', {
        limit: 5,
        until: '2026-03-21',
      });
      expect(hits.map((h) => h.frame.id)).toContain(f.id);
    });

    it('fencepost: still excludes frames after the until day', async () => {
      const f = frames.createIFrame('gop-a', 'quarterly metrics review for the launch');
      setCreatedAt(f.id, '2026-03-22T00:30:00.000Z');

      const hits = await search.search('quarterly metrics review', {
        limit: 5,
        until: '2026-03-21',
      });
      expect(hits.map((h) => h.frame.id)).not.toContain(f.id);
    });

    it('fencepost: date-only since includes frames from midnight of that day', async () => {
      const f = frames.createIFrame('gop-a', 'quarterly metrics review for the launch');
      setCreatedAt(f.id, '2026-03-21T00:30:00.000Z');

      const hits = await search.search('quarterly metrics review', {
        limit: 5,
        since: '2026-03-21',
      });
      expect(hits.map((h) => h.frame.id)).toContain(f.id);
    });

    it('slot consumption: windowed search reaches past out-of-window candidates', async () => {
      // 30 out-of-window frames that rank HIGHER on the keyword lane (denser
      // keyword repetition) — pre-fix these filled the limit*2 lane slots and
      // the post-filter left nothing.
      for (let i = 0; i < 30; i++) {
        const f = frames.createIFrame('gop-a', `alpha rollout alpha checklist item ${i} alpha`);
        setCreatedAt(f.id, '2026-06-01T08:00:00.000Z');
      }
      // 3 in-window frames, weaker keyword density.
      const inWindow: number[] = [];
      for (let i = 0; i < 3; i++) {
        const f = frames.createIFrame('gop-a', `alpha planning note ${i} from spring`);
        setCreatedAt(f.id, `2025-05-1${i}T09:00:00.000Z`);
        inWindow.push(f.id);
      }

      const hits = await search.search('alpha', {
        limit: 5,
        since: '2025-05-01',
        until: '2025-05-31',
      });
      const ids = hits.map((h) => h.frame.id);
      for (const id of inWindow) expect(ids).toContain(id);
    });
  });

  describe('LIKE keyword fallback on FTS5 parse errors', () => {
    it('keywordSearch degrades to a LIKE scan instead of returning empty', async () => {
      const f = frames.createIFrame('gop-a', 'roadmap for the Q2 launch milestones');
      // A query containing a quote is passed to FTS5 raw (caller-quoted
      // convention); the unbalanced quote makes FTS5 throw a parse error.
      const ids = await search.keywordSearch('launch "milestones', 10);
      expect(ids).toContain(f.id);
    });

    it('LIKE fallback honours gopId scoping', async () => {
      const inA = frames.createIFrame('gop-a', 'incident postmortem draft alpha');
      const inB = frames.createIFrame('gop-b', 'incident postmortem draft bravo');
      const scoped = await search.keywordSearch('postmortem "draft', 10, 'gop-a');
      expect(scoped).toContain(inA.id);
      expect(scoped).not.toContain(inB.id);
    });

    it('returns [] when nothing matches even via the fallback', async () => {
      frames.createIFrame('gop-a', 'completely unrelated content');
      const ids = await search.keywordSearch('zzznothing "qqq', 10);
      expect(ids).toEqual([]);
    });
  });

  describe('chunk-retrieval flag (HIVE_MIND_CHUNK_RETRIEVAL) + auto-chunk-indexing', () => {
    const ENV_KEY = 'HIVE_MIND_CHUNK_RETRIEVAL';
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = savedEnv;
    });

    it('is ON by default and OFF only with the =0 kill switch', () => {
      delete process.env[ENV_KEY];
      expect(chunkRetrievalEnabled()).toBe(true);
      process.env[ENV_KEY] = '1';
      expect(chunkRetrievalEnabled()).toBe(true);
      process.env[ENV_KEY] = '0';
      expect(chunkRetrievalEnabled()).toBe(false);
    });

    it('indexFrame chunk-indexes the frame by default (write side in lockstep)', async () => {
      delete process.env[ENV_KEY];
      const f = frames.createIFrame('gop-a', 'auto chunk indexing on live write');
      await search.indexFrame(f.id, f.content);
      const n = (db.getDatabase()
        .prepare('SELECT COUNT(*) AS n FROM memory_frame_chunks WHERE frame_id = ?')
        .get(f.id) as { n: number }).n;
      expect(n).toBeGreaterThan(0);
    });

    it('indexFrame skips chunk indexing when the kill switch is set', async () => {
      process.env[ENV_KEY] = '0';
      const f = frames.createIFrame('gop-a', 'no chunks under the kill switch');
      await search.indexFrame(f.id, f.content);
      const n = (db.getDatabase()
        .prepare('SELECT COUNT(*) AS n FROM memory_frame_chunks')
        .get() as { n: number }).n;
      expect(n).toBe(0);
    });

    it('indexFramesBatch chunk-indexes every frame in the batch by default', async () => {
      delete process.env[ENV_KEY];
      const a = frames.createIFrame('gop-a', 'batch chunk frame alpha');
      const b = frames.createIFrame('gop-a', 'batch chunk frame bravo');
      await search.indexFramesBatch([
        { id: a.id, content: a.content },
        { id: b.id, content: b.content },
      ]);
      const distinct = (db.getDatabase()
        .prepare('SELECT COUNT(DISTINCT frame_id) AS n FROM memory_frame_chunks')
        .get() as { n: number }).n;
      expect(distinct).toBe(2);
    });

    it('rechunkAllFrames backfills chunks for every non-deprecated frame regardless of the flag', async () => {
      process.env[ENV_KEY] = '0'; // backfill must run even with the lane off
      frames.createIFrame('gop-a', 'rechunk target one');
      frames.createIFrame('gop-a', 'rechunk target two');
      frames.createIFrame('gop-a', 'rechunk skipped frame', 'deprecated');

      const result = await rechunkAllFrames(db, search);
      expect(result.framesProcessed).toBe(2);
      expect(result.framesFailed).toBe(0);
      expect(result.chunksCreated).toBeGreaterThanOrEqual(2);
      const distinct = (db.getDatabase()
        .prepare('SELECT COUNT(DISTINCT frame_id) AS n FROM memory_frame_chunks')
        .get() as { n: number }).n;
      expect(distinct).toBe(2);
    });
  });

  it('search() honours gopId scoping end-to-end', async () => {
    // NOTE: FrameStore.createIFrame dedups by content across all GOPs, so the
    // two gop-scoped frames must differ to avoid the dedup returning the same
    // row twice (which would then UNIQUE-violate on vec insert).
    const inA = frames.createIFrame('gop-a', 'report for project apollo alpha');
    const inB = frames.createIFrame('gop-b', 'report for project apollo bravo');
    await search.indexFramesBatch([
      { id: inA.id, content: inA.content },
      { id: inB.id, content: inB.content },
    ]);

    const results = await search.search('report apollo', { gopId: 'gop-a', limit: 10 });
    const ids = results.map((r) => r.frame.id);
    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(inB.id);
  });
});

describe('assessRetrievalConfidence (abstain scaffold)', () => {
  const mk = (finalScore: number): SearchResult =>
    ({ frame: {} as never, rrfScore: 0, relevanceScore: 0, finalScore });

  it('empty result set is always insufficient (topScore 0)', () => {
    const v = assessRetrievalConfidence([], 0.3);
    expect(v.sufficient).toBe(false);
    expect(v.topScore).toBe(0);
    expect(v.threshold).toBe(0.3);
  });

  it('sufficient when the top finalScore is strictly above the threshold', () => {
    const v = assessRetrievalConfidence([mk(0.42), mk(0.1)], 0.3);
    expect(v.sufficient).toBe(true);
    expect(v.topScore).toBe(0.42);
  });

  it('insufficient when the top finalScore is below the threshold', () => {
    expect(assessRetrievalConfidence([mk(0.05)], 0.3).sufficient).toBe(false);
  });

  it('threshold is strict (equal does NOT pass)', () => {
    expect(assessRetrievalConfidence([mk(0.3)], 0.3).sufficient).toBe(false);
  });

  it('reads only the top result (results are pre-sorted by finalScore desc)', () => {
    // Even if a later element is high, the verdict is driven by index 0.
    expect(assessRetrievalConfidence([mk(0.01), mk(0.99)], 0.3).topScore).toBe(0.01);
  });
});

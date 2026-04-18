import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB } from './db.js';
import { FrameStore } from './frames.js';
import { HybridSearch } from './search.js';
import { createEmbeddingProvider, type EmbeddingProviderInstance } from './embedding-provider.js';

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

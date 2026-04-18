import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindDB } from '@hive-mind/core';
import { CompilationState, contentHash } from './state.js';

describe('CompilationState', () => {
  let dbPath: string;
  let db: MindDB;
  let state: CompilationState;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hmind-wiki-state-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    state = new CompilationState(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('contentHash() is stable and returns a 16-char sha256 prefix', () => {
    const a = contentHash('hello world');
    const b = contentHash('hello world');
    const c = contentHash('different');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it('getWatermark() returns zeros before first compile', () => {
    const w = state.getWatermark();
    expect(w.lastFrameId).toBe(0);
    expect(w.pagesCompiled).toBe(0);
    expect(w.lastCompiledAt).toBe('');
  });

  it('updateWatermark() persists and upserts on subsequent calls', () => {
    state.updateWatermark(42, 5);
    let w = state.getWatermark();
    expect(w.lastFrameId).toBe(42);
    expect(w.pagesCompiled).toBe(5);
    expect(w.lastCompiledAt).toMatch(/\d{4}-\d{2}-\d{2}/);

    state.updateWatermark(100, 12);
    w = state.getWatermark();
    expect(w.lastFrameId).toBe(100);
    expect(w.pagesCompiled).toBe(12);
  });

  it('upsertPage() returns created / updated / unchanged by content hash', () => {
    const first = state.upsertPage('slug-a', 'entity', 'Alice', 'hash-1', [1, 2], 2, '# Alice v1');
    expect(first.action).toBe('created');

    // Same content hash → unchanged
    const same = state.upsertPage('slug-a', 'entity', 'Alice', 'hash-1', [1, 2], 2, '# Alice v1');
    expect(same.action).toBe('unchanged');

    // Different content hash → updated
    const updated = state.upsertPage('slug-a', 'entity', 'Alice', 'hash-2', [1, 2, 3], 3, '# Alice v2');
    expect(updated.action).toBe('updated');
  });

  it('getPage() / getAllPages() / getPagesByType() round-trip correctly', () => {
    state.upsertPage('a', 'entity', 'Alice', 'h-a', [1], 1, '# A');
    state.upsertPage('b', 'entity', 'Bob', 'h-b', [2], 1, '# B');
    state.upsertPage('c', 'concept', 'Roadmap', 'h-c', [3], 1, '# C');

    const a = state.getPage('a');
    expect(a?.name).toBe('Alice');
    expect(a?.contentHash).toBe('h-a');
    expect(a?.markdown).toBe('# A');

    const all = state.getAllPages();
    expect(all).toHaveLength(3);
    // Ordered by name
    expect(all.map((p) => p.name)).toEqual(['Alice', 'Bob', 'Roadmap']);

    const entities = state.getPagesByType('entity');
    expect(entities.map((p) => p.name)).toEqual(['Alice', 'Bob']);

    const concepts = state.getPagesByType('concept');
    expect(concepts.map((p) => p.name)).toEqual(['Roadmap']);
  });

  it('deletePage() removes by slug and returns whether a row changed', () => {
    state.upsertPage('a', 'entity', 'Alice', 'h', [], 0, '# A');
    expect(state.deletePage('a')).toBe(true);
    expect(state.deletePage('a')).toBe(false);
    expect(state.getPage('a')).toBeUndefined();
  });

  it('getMaxFrameId() queries the memory_frames table (0 when empty)', () => {
    expect(state.getMaxFrameId()).toBe(0);

    // Insert a session + two frames directly against the db
    const raw = db.getDatabase();
    raw.prepare(
      "INSERT INTO sessions (gop_id, status, started_at) VALUES ('g-1', 'active', datetime('now'))",
    ).run();
    raw.prepare(
      "INSERT INTO memory_frames (frame_type, gop_id, t, content) VALUES ('I', 'g-1', 0, 'first')",
    ).run();
    raw.prepare(
      "INSERT INTO memory_frames (frame_type, gop_id, t, content) VALUES ('I', 'g-1', 1, 'second')",
    ).run();

    expect(state.getMaxFrameId()).toBe(2);
  });

  it('getFramesSince() returns only frames with id > watermark', () => {
    const raw = db.getDatabase();
    raw.prepare(
      "INSERT INTO sessions (gop_id, status, started_at) VALUES ('g-1', 'active', datetime('now'))",
    ).run();
    for (let i = 0; i < 5; i++) {
      raw.prepare(
        "INSERT INTO memory_frames (frame_type, gop_id, t, content) VALUES ('I', 'g-1', ?, ?)",
      ).run(i, `frame ${i}`);
    }

    const afterTwo = state.getFramesSince(2);
    expect(afterTwo.map((f) => f.id)).toEqual([3, 4, 5]);
    expect(afterTwo[0].content).toBe('frame 2');
  });
});

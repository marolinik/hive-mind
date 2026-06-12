import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB } from './db.js';
import { FrameStore, stripHmPrefix } from './frames.js';

describe('FrameStore', () => {
  let dbPath: string;
  let db: MindDB;
  let frames: FrameStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hive-mind-frames-test-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    // A parent session is required because memory_frames.gop_id is a FK to sessions.
    db.getDatabase()
      .prepare("INSERT INTO sessions (gop_id, status, started_at) VALUES ('gop-test', 'active', datetime('now'))")
      .run();
    frames = new FrameStore(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('creates I-frames with monotonically increasing t within a GOP', () => {
    const a = frames.createIFrame('gop-test', 'first', 'normal');
    const b = frames.createIFrame('gop-test', 'second', 'normal');
    expect(a.frame_type).toBe('I');
    expect(b.frame_type).toBe('I');
    expect(a.t).toBe(0);
    expect(b.t).toBe(1);
    expect(b.id).toBeGreaterThan(a.id);
  });

  it('createPFrame attaches to a base I-frame', () => {
    const iframe = frames.createIFrame('gop-test', 'base state');
    const pframe = frames.createPFrame('gop-test', 'delta update', iframe.id);
    expect(pframe.frame_type).toBe('P');
    expect(pframe.base_frame_id).toBe(iframe.id);
  });

  it('createBFrame stores referenced frame IDs in the parsed content', () => {
    const a = frames.createIFrame('gop-test', 'A');
    const b = frames.createIFrame('gop-test', 'B');
    const c = frames.createIFrame('gop-test', 'C');
    const bridge = frames.createBFrame('gop-test', 'links a-b-c', a.id, [b.id, c.id]);
    expect(bridge.frame_type).toBe('B');
    expect(frames.getBFrameReferences(bridge.id)).toEqual([b.id, c.id]);
  });

  it('reconstructState returns the latest I-frame and following P-frames', () => {
    const iframe = frames.createIFrame('gop-test', 'state v1', 'important');
    frames.createPFrame('gop-test', 'delta 1', iframe.id);
    frames.createPFrame('gop-test', 'delta 2', iframe.id);

    const state = frames.reconstructState('gop-test');
    expect(state.iframe?.id).toBe(iframe.id);
    expect(state.pframes).toHaveLength(2);
    expect(state.pframes.map((p) => p.content)).toEqual(['delta 1', 'delta 2']);
  });

  it('createIFrame honors a valid ISO-8601 createdAt override', () => {
    // Sprint 9 Task 0 regression: the harvest path depends on this
    // createdAt override to preserve original source timestamps.
    const ts = '2025-12-01T14:32:00Z';
    const f = frames.createIFrame('gop-test', 'harvested content', 'normal', 'import', ts);
    expect(f.created_at).toBe(ts);
    expect(f.last_accessed).toBe(ts);
  });

  it('createIFrame with undefined createdAt falls back to the schema default (NOW())', () => {
    const before = Date.now();
    const f = frames.createIFrame('gop-test', 'undefined-ts content', 'normal', 'import', undefined);
    const after = Date.now();
    // SQLite datetime('now') returns UTC "YYYY-MM-DD HH:MM:SS" (no T, no Z).
    expect(f.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const parsed = Date.parse(f.created_at.replace(' ', 'T') + 'Z');
    expect(parsed).toBeGreaterThanOrEqual(before - 5000);
    expect(parsed).toBeLessThanOrEqual(after + 5000);
  });

  it('createIFrame with an invalid-ISO string falls back to the schema default (NOW())', () => {
    const before = Date.now();
    const f = frames.createIFrame(
      'gop-test',
      'invalid-ts content',
      'normal',
      'import',
      'not-a-valid-iso-string',
    );
    const after = Date.now();
    // The literal junk must never reach storage — otherwise range queries
    // on created_at silently break.
    expect(f.created_at).not.toBe('not-a-valid-iso-string');
    expect(f.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const parsed = Date.parse(f.created_at.replace(' ', 'T') + 'Z');
    expect(parsed).toBeGreaterThanOrEqual(before - 5000);
    expect(parsed).toBeLessThanOrEqual(after + 5000);
  });

  it('createIFrame with a null createdAt falls back to the schema default', () => {
    // null is the explicit "no timestamp" signal harvest-local.ts passes
    // down after its own validator rejects the caller's input.
    const f = frames.createIFrame('gop-test', 'null-ts content', 'normal', 'import', null);
    expect(f.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('dedups identical content on createIFrame and increments access_count', () => {
    const first = frames.createIFrame('gop-test', 'repeated content');
    const second = frames.createIFrame('gop-test', 'repeated content');
    expect(second.id).toBe(first.id);
    const row = frames.getById(first.id);
    expect(row?.access_count).toBeGreaterThanOrEqual(1);
  });

  it('update() rewrites content and importance and keeps FTS in sync', () => {
    const iframe = frames.createIFrame('gop-test', 'original');
    const updated = frames.update(iframe.id, 'revised', 'critical');
    expect(updated?.content).toBe('revised');
    expect(updated?.importance).toBe('critical');

    const ftsHit = db
      .getDatabase()
      .prepare('SELECT rowid FROM memory_frames_fts WHERE memory_frames_fts MATCH ?')
      .all('revised') as { rowid: number }[];
    expect(ftsHit.map((r) => r.rowid)).toContain(iframe.id);
  });

  it('delete() removes the row, FTS entry, and clears back-references', () => {
    const base = frames.createIFrame('gop-test', 'base');
    const dependent = frames.createPFrame('gop-test', 'dependent', base.id);

    const ok = frames.delete(base.id);
    expect(ok).toBe(true);
    expect(frames.getById(base.id)).toBeUndefined();

    // Dependent P-frame must survive with base_frame_id cleared to null.
    const survivor = frames.getById(dependent.id);
    expect(survivor).toBeDefined();
    expect(survivor?.base_frame_id).toBeNull();
  });

  it('compact() prunes stale temporary frames older than maxTempAgeDays', () => {
    const tempFrame = frames.createIFrame('gop-test', 'ephemeral', 'temporary');
    // Age the frame 100 days into the past so a 30-day cutoff prunes it.
    db.getDatabase()
      .prepare("UPDATE memory_frames SET created_at = datetime('now', '-100 days') WHERE id = ?")
      .run(tempFrame.id);

    const result = frames.compact(30, 90);
    expect(result.temporaryPruned).toBe(1);
    expect(frames.getById(tempFrame.id)).toBeUndefined();
  });

  it('getStats() aggregates counts by type and importance', () => {
    frames.createIFrame('gop-test', 'a', 'critical');
    frames.createIFrame('gop-test', 'b', 'normal');
    const base = frames.createIFrame('gop-test', 'c', 'important');
    frames.createPFrame('gop-test', 'd', base.id, 'normal');

    const stats = frames.getStats();
    expect(stats.total).toBe(4);
    expect(stats.byType.I).toBe(3);
    expect(stats.byType.P).toBe(1);
    expect(stats.byImportance.critical).toBe(1);
    expect(stats.byImportance.important).toBe(1);
    expect(stats.byImportance.normal).toBe(2);
  });

  it('dedups identical content even when the original is far outside the recent-500 window', () => {
    // The old scan-based findDuplicate only looked at the last 500 frames, so an
    // identical frame buried deeper silently re-inserted. The content_hash index
    // makes dedup global. This is the key regression for the scan→index swap.
    const original = frames.createIFrame('gop-test', 'needle in a haystack');
    for (let i = 0; i < 600; i++) {
      frames.createIFrame('gop-test', `filler content number ${i}`);
    }
    const redup = frames.createIFrame('gop-test', 'needle in a haystack');
    expect(redup.id).toBe(original.id);
  });

  it('dedups content regardless of surrounding whitespace (trim-equivalent)', () => {
    const a = frames.createIFrame('gop-test', 'trimmed body');
    const b = frames.createIFrame('gop-test', '   trimmed body\n');
    expect(b.id).toBe(a.id);
  });

  it('update() rewrites the content hash so dedup tracks the new content', () => {
    const a = frames.createIFrame('gop-test', 'alpha payload');
    frames.update(a.id, 'beta payload');
    // New content now dedups to A...
    const reBeta = frames.createIFrame('gop-test', 'beta payload');
    expect(reBeta.id).toBe(a.id);
    // ...and the OLD content must NOT dedup to A (stale-hash guard).
    const reAlpha = frames.createIFrame('gop-test', 'alpha payload');
    expect(reAlpha.id).not.toBe(a.id);
  });

  it('maintains a content_hash index used by the dedup lookup', () => {
    const raw = db.getDatabase();
    const idx = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_frames_content_hash'")
      .all();
    expect(idx).toHaveLength(1);
    const plan = raw
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM memory_frames WHERE content_hash = ? ORDER BY id DESC LIMIT 1',
      )
      .all('anyhash') as { detail: string }[];
    expect(plan.some((p) => /idx_frames_content_hash/.test(p.detail))).toBe(true);
  });

  it('backfills content_hash for legacy frames on open and dedups against them', () => {
    const a = frames.createIFrame('gop-test', 'legacy row body');
    // Simulate a pre-migration DB row with no hash.
    db.getDatabase().prepare('UPDATE memory_frames SET content_hash = NULL WHERE id = ?').run(a.id);
    db.close();
    // Reopen → runMigrations should backfill the missing hash.
    db = new MindDB(dbPath);
    frames = new FrameStore(db);
    const row = db
      .getDatabase()
      .prepare('SELECT content_hash FROM memory_frames WHERE id = ?')
      .get(a.id) as { content_hash: string | null };
    expect(row.content_hash).toBeTruthy();
    const redup = frames.createIFrame('gop-test', 'legacy row body');
    expect(redup.id).toBe(a.id);
  });

  // ── Forward-ported from waggle-os monorepo (mono-parity 2026-06-12) ──────

  it('dedups provenance-insensitively: same body under different [hm …] prefixes collapses', () => {
    const a = frames.createIFrame(
      'gop-test',
      '[hm session:abc src:claude-code event:stop] the user prefers dark mode',
    );
    const b = frames.createIFrame(
      'gop-test',
      '[hm session:xyz src:cursor event:stop] the user prefers dark mode',
    );
    expect(b.id).toBe(a.id);
    // Bare body (no prefix) also collapses into the same frame.
    const c = frames.createIFrame('gop-test', 'the user prefers dark mode');
    expect(c.id).toBe(a.id);
  });

  it('stripHmPrefix removes only a leading [hm …] block, never mid-content brackets', () => {
    expect(stripHmPrefix('[hm session:1 src:x] body text')).toBe('body text');
    expect(stripHmPrefix('no prefix [hm session:1] later')).toBe('no prefix [hm session:1] later');
    expect(stripHmPrefix('plain body')).toBe('plain body');
  });

  it('touch() returns the new access_count, or undefined for an unknown id', () => {
    const f = frames.createIFrame('gop-test', 'touch target');
    expect(f.access_count).toBe(0);
    expect(frames.touch(f.id)).toBe(1);
    expect(frames.touch(f.id)).toBe(2);
    expect(frames.touch(999_999)).toBeUndefined();
  });

  it('deleteByContentPrefix deletes exactly the frames starting with the literal prefix', () => {
    const a1 = frames.createIFrame('gop-test', 'card:alice v1 details');
    const a2 = frames.createIFrame('gop-test', 'card:alice v2 details');
    const bob = frames.createIFrame('gop-test', 'card:bob v1 details');

    const deleted = frames.deleteByContentPrefix('card:alice');
    expect(deleted).toBe(2);
    expect(frames.getById(a1.id)).toBeUndefined();
    expect(frames.getById(a2.id)).toBeUndefined();
    expect(frames.getById(bob.id)).toBeDefined();
    // FTS rows cleaned up too (routes through delete()).
    const ftsLeft = db
      .getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM memory_frames_fts WHERE rowid IN (?, ?)')
      .get(a1.id, a2.id) as { n: number };
    expect(ftsLeft.n).toBe(0);
  });

  it('deleteByContentPrefix escapes LIKE metacharacters (literal match only)', () => {
    const literal = frames.createIFrame('gop-test', '100% done with the rollout');
    const decoy = frames.createIFrame('gop-test', '1000 done with the rollout');

    // An unescaped '%' would wildcard-match the decoy too.
    const deleted = frames.deleteByContentPrefix('100%');
    expect(deleted).toBe(1);
    expect(frames.getById(literal.id)).toBeUndefined();
    expect(frames.getById(decoy.id)).toBeDefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB } from './db.js';
import { AwarenessLayer } from './awareness.js';

describe('AwarenessLayer', () => {
  let dbPath: string;
  let db: MindDB;
  let awareness: AwarenessLayer;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hive-mind-awareness-test-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    awareness = new AwarenessLayer(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('add() inserts a row with defaults and get() round-trips it', () => {
    const item = awareness.add('task', 'review PR #42');
    expect(item.category).toBe('task');
    expect(item.content).toBe('review PR #42');
    expect(item.priority).toBe(0);
    expect(item.expires_at).toBeNull();
    expect(JSON.parse(item.metadata)).toEqual({});

    const loaded = awareness.get(item.id);
    expect(loaded?.id).toBe(item.id);
  });

  it('add() with metadata stores it as JSON and parseMetadata reads it back', () => {
    const item = awareness.add('action', 'ran tests', 5, undefined, {
      context: 'CI pipeline',
      status: 'success',
    });
    const meta = awareness.parseMetadata(item);
    expect(meta.context).toBe('CI pipeline');
    expect(meta.status).toBe('success');
  });

  it('update() rewrites fields and leaves others unchanged', () => {
    const item = awareness.add('pending', 'waiting for review', 2);
    const updated = awareness.update(item.id, { priority: 9 });
    expect(updated.priority).toBe(9);
    expect(updated.content).toBe('waiting for review');

    // No-op update returns the row as-is.
    const same = awareness.update(item.id, {});
    expect(same.priority).toBe(9);
  });

  it('updateMetadata() merges into existing metadata without replacing untouched keys', () => {
    const item = awareness.add('flag', 'context-switch', 0, undefined, {
      context: 'onboarding',
    });
    const merged = awareness.updateMetadata(item.id, { status: 'in_progress' });
    const meta = awareness.parseMetadata(merged);
    expect(meta.context).toBe('onboarding');
    expect(meta.status).toBe('in_progress');
  });

  it('updateMetadata() throws for unknown ids', () => {
    expect(() => awareness.updateMetadata(9999, { status: 'x' })).toThrow(
      /Awareness item 9999 not found/,
    );
  });

  it('getAll() orders by priority desc and caps at MAX_ITEMS (10)', () => {
    for (let i = 0; i < 15; i++) {
      awareness.add('task', `task ${i}`, i);
    }
    const all = awareness.getAll();
    expect(all).toHaveLength(10);
    // Highest priority first — last inserted (priority 14) should be first.
    expect(all[0].priority).toBe(14);
    expect(all[9].priority).toBe(5);
  });

  it('getByCategory() filters by category and respects the MAX_ITEMS cap', () => {
    for (let i = 0; i < 12; i++) awareness.add('task', `t${i}`, i);
    awareness.add('flag', 'f-only', 100);

    const tasks = awareness.getByCategory('task');
    expect(tasks).toHaveLength(10);
    expect(tasks.every((t) => t.category === 'task')).toBe(true);

    const flags = awareness.getByCategory('flag');
    expect(flags).toHaveLength(1);
    expect(flags[0].content).toBe('f-only');
  });

  it('getByStatus() returns only items whose metadata.status matches', () => {
    awareness.add('action', 'a1', 0, undefined, { status: 'done' });
    awareness.add('action', 'a2', 0, undefined, { status: 'pending' });
    awareness.add('action', 'a3', 0, undefined, { status: 'done' });

    const done = awareness.getByStatus('done').map((i) => i.content).sort();
    expect(done).toEqual(['a1', 'a3']);
  });

  it('expired items are excluded from getAll() / getByCategory()', () => {
    // The query filters via `expires_at > datetime('now')`, which is a raw
    // string comparison in SQLite. `datetime('now')` yields `'YYYY-MM-DD HH:MM:SS'`
    // (space separator, no fractional seconds, no Z). Full ISO strings (`T`
    // separator, `Z` suffix) sort greater than any space-separated value in
    // ASCII, so feeding ISO strings here would mask expiry. The test uses
    // SQLite-native format to exercise the intended contract.
    const sqliteDatetime = (offsetMs: number): string => {
      const d = new Date(Date.now() + offsetMs);
      return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    };

    awareness.add('task', 'expired', 0, sqliteDatetime(-60_000));
    const alive = awareness.add('task', 'alive', 0, sqliteDatetime(+60_000));

    const visible = awareness.getAll().map((i) => i.id);
    expect(visible).toEqual([alive.id]);
  });

  it('remove() / clear() / clearCategory() delete rows as expected', () => {
    const a = awareness.add('task', 'a');
    awareness.add('task', 'b');
    awareness.add('flag', 'c');

    awareness.remove(a.id);
    expect(awareness.get(a.id)).toBeUndefined();

    awareness.clearCategory('task');
    expect(awareness.getByCategory('task')).toEqual([]);
    expect(awareness.getByCategory('flag')).toHaveLength(1);

    awareness.clear();
    expect(awareness.getAll()).toEqual([]);
  });

  it('toContext() renders section headers per non-empty category, skipping empty ones', () => {
    awareness.add('task', 'T1', 1);
    awareness.add('task', 'T2', 0);
    awareness.add('flag', 'F1', 0);

    const ctx = awareness.toContext();
    expect(ctx).toContain('Active Tasks:');
    expect(ctx).toContain('- T1');
    expect(ctx).toContain('- T2');
    expect(ctx).toContain('Context Flags:');
    expect(ctx).toContain('- F1');
    expect(ctx).not.toContain('Recent Actions:');
    expect(ctx).not.toContain('Pending Items:');
  });

  it('toContext() returns a sentinel message when there is no active content', () => {
    expect(awareness.toContext()).toBe('No active awareness items.');
  });
});

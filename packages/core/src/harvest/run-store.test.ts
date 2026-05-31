import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB } from '../mind/db.js';
import { HarvestRunStore } from './run-store.js';

describe('HarvestRunStore', () => {
  let dbPath: string;
  let db: MindDB;
  let store: HarvestRunStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hive-mind-runstore-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    store = new HarvestRunStore(db);
  });

  afterEach(() => {
    db.close();
    for (const s of ['', '-shm', '-wal']) if (existsSync(dbPath + s)) rmSync(dbPath + s);
  });

  it('start() creates a running run with the given source and totals', () => {
    const run = store.start('chatgpt', 10, '/tmp/cache.json');
    expect(run.id).toBeGreaterThan(0);
    expect(run.status).toBe('running');
    expect(run.source).toBe('chatgpt');
    expect(run.totalItems).toBe(10);
    expect(run.itemsSaved).toBe(0);
    expect(run.inputCachePath).toBe('/tmp/cache.json');
    expect(run.finishedAt).toBeNull();
  });

  it('heartbeat() updates items_saved on a running run', () => {
    const run = store.start('claude', 5);
    store.heartbeat(run.id, 3);
    expect(store.getById(run.id)?.itemsSaved).toBe(3);
  });

  it('complete() transitions to completed and is idempotent on terminal rows', () => {
    const run = store.start('gemini', 4);
    store.complete(run.id, 4);
    const done = store.getById(run.id)!;
    expect(done.status).toBe('completed');
    expect(done.itemsSaved).toBe(4);
    expect(done.finishedAt).not.toBeNull();
    // A later heartbeat must NOT mutate a terminal row.
    store.heartbeat(run.id, 99);
    expect(store.getById(run.id)?.itemsSaved).toBe(4);
  });

  it('fail() records the error (truncated to 2000 chars) and optional itemsSaved', () => {
    const run = store.start('claude-code', 8);
    store.fail(run.id, 'x'.repeat(3000), 2);
    const f = store.getById(run.id)!;
    expect(f.status).toBe('failed');
    expect(f.itemsSaved).toBe(2);
    expect(f.errorMessage).toHaveLength(2000);
  });

  it('abandon() works from running or failed', () => {
    const a = store.start('chatgpt', 1);
    store.abandon(a.id);
    expect(store.getById(a.id)?.status).toBe('abandoned');

    const b = store.start('chatgpt', 1);
    store.fail(b.id, 'boom');
    store.abandon(b.id);
    expect(store.getById(b.id)?.status).toBe('abandoned');
  });

  it('getLatestInterrupted() surfaces the latest running/failed row with a cache path', () => {
    // completed → not interrupted
    store.complete(store.start('chatgpt', 1, '/c1').id, 1);
    // running WITH cache → the one interrupted run we expect back
    const r2 = store.start('claude', 1, '/c2');
    // running WITHOUT a cache path → never surfaced
    store.start('gemini', 1, null);

    const latest = store.getLatestInterrupted();
    expect(latest?.id).toBe(r2.id);
    expect(latest?.inputCachePath).toBe('/c2');
  });

  it('getAll() returns recorded runs and respects the limit', () => {
    store.start('chatgpt', 1);
    store.start('claude', 1);
    store.start('gemini', 1);
    expect(store.getAll()).toHaveLength(3);
    expect(store.getAll(2)).toHaveLength(2);
  });
});

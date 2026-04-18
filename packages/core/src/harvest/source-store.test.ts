import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB } from '../mind/db.js';
import { HarvestSourceStore } from './source-store.js';

describe('HarvestSourceStore', () => {
  let dbPath: string;
  let db: MindDB;
  let store: HarvestSourceStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hive-mind-harvest-src-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    store = new HarvestSourceStore(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('self-bootstraps harvest_sources on first construction', () => {
    const row = db
      .getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='harvest_sources'")
      .get();
    expect(row).toBeTruthy();
  });

  it('upsert inserts a new source and is idempotent on repeat calls', () => {
    const a = store.upsert('chatgpt', 'ChatGPT', '/home/u/exports');
    expect(a.source).toBe('chatgpt');
    expect(a.displayName).toBe('ChatGPT');
    expect(a.sourcePath).toBe('/home/u/exports');
    expect(a.itemsImported).toBe(0);
    expect(a.autoSync).toBe(false);

    // Second upsert updates displayName + preserves sourcePath via COALESCE.
    const b = store.upsert('chatgpt', 'ChatGPT (renamed)');
    expect(b.id).toBe(a.id);
    expect(b.displayName).toBe('ChatGPT (renamed)');
    expect(b.sourcePath).toBe('/home/u/exports');
  });

  it('recordSync accumulates counters and stamps last_synced_at', () => {
    store.upsert('claude', 'Claude');
    store.recordSync('claude', 42, 17, 'hash-v1');
    store.recordSync('claude', 8, 3, 'hash-v2');

    const row = store.getBySource('claude');
    expect(row?.itemsImported).toBe(50);
    expect(row?.framesCreated).toBe(20);
    expect(row?.lastContentHash).toBe('hash-v2');
    expect(row?.lastSyncedAt).not.toBeNull();
  });

  it('setAutoSync toggles the flag and (optionally) interval', () => {
    store.upsert('gemini', 'Gemini');

    store.setAutoSync('gemini', true, 6);
    let row = store.getBySource('gemini');
    expect(row?.autoSync).toBe(true);
    expect(row?.syncIntervalHours).toBe(6);

    // Omitting interval preserves the existing value via COALESCE.
    store.setAutoSync('gemini', false);
    row = store.getBySource('gemini');
    expect(row?.autoSync).toBe(false);
    expect(row?.syncIntervalHours).toBe(6);
  });

  it('getStale returns only auto_sync sources whose interval has elapsed', () => {
    store.upsert('chatgpt', 'ChatGPT');
    store.upsert('claude', 'Claude');
    store.upsert('gemini', 'Gemini');

    // chatgpt: auto_sync off.
    store.setAutoSync('chatgpt', false);
    // claude: auto_sync on + never synced (NULL last_synced_at → stale).
    store.setAutoSync('claude', true, 24);
    // gemini: auto_sync on + just synced → not stale.
    store.setAutoSync('gemini', true, 24);
    store.recordSync('gemini', 1, 1);

    const stale = store.getStale().map((s) => s.source).sort();
    expect(stale).toEqual(['claude']);
  });

  it('getAll returns every registered source', () => {
    store.upsert('chatgpt', 'ChatGPT');
    store.upsert('claude', 'Claude');
    expect(store.getAll().map((s) => s.source).sort()).toEqual(['chatgpt', 'claude']);
  });

  it('remove deletes a source and getBySource returns null thereafter', () => {
    store.upsert('pdf', 'PDF import');
    expect(store.getBySource('pdf')).not.toBeNull();
    store.remove('pdf');
    expect(store.getBySource('pdf')).toBeNull();
  });
});

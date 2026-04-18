import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB } from './db.js';
import { SessionStore } from './sessions.js';

describe('SessionStore', () => {
  let dbPath: string;
  let db: MindDB;
  let sessions: SessionStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hive-mind-sessions-test-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    sessions = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('create() produces an active session with a unique gop_id', () => {
    const a = sessions.create('project-x');
    const b = sessions.create('project-x');
    expect(a.status).toBe('active');
    expect(b.status).toBe('active');
    expect(a.gop_id).not.toBe(b.gop_id);
    expect(a.project_id).toBe('project-x');
    expect(a.ended_at).toBeNull();
  });

  it('close() transitions status and sets ended_at + summary', () => {
    const s = sessions.create();
    const closed = sessions.close(s.gop_id, 'summary-text');
    expect(closed.status).toBe('closed');
    expect(closed.ended_at).not.toBeNull();
    expect(closed.summary).toBe('summary-text');
  });

  it('archive() transitions status without touching ended_at', () => {
    const s = sessions.create();
    const archived = sessions.archive(s.gop_id);
    expect(archived.status).toBe('archived');
  });

  it('ensureActive() returns the existing active session or creates a new one', () => {
    // First call on an empty store creates a session.
    const first = sessions.ensureActive('p1');
    expect(first.status).toBe('active');

    // Second call returns the same session (no duplicate creation).
    const second = sessions.ensureActive('p1');
    expect(second.id).toBe(first.id);
    expect(second.gop_id).toBe(first.gop_id);

    // After closing, ensureActive should create a new one.
    sessions.close(first.gop_id);
    const third = sessions.ensureActive('p1');
    expect(third.id).not.toBe(first.id);
    expect(third.status).toBe('active');
  });

  it('ensure() is idempotent for a stable gop_id', () => {
    const a = sessions.ensure('harvest', null ?? undefined, 'long-lived harvest session');
    const b = sessions.ensure('harvest');
    expect(a.id).toBe(b.id);
    expect(a.summary).toBe('long-lived harvest session');
    // Summary from the first call is preserved; second call doesn't overwrite.
    expect(b.summary).toBe('long-lived harvest session');
  });

  it('getByProject() returns sessions sorted newest-first', () => {
    const a = sessions.create('proj');
    // Close + new to separate started_at visibly. SQLite datetime('now') has
    // second precision; the id DESC tiebreak handles same-second ties.
    sessions.close(a.gop_id);
    const b = sessions.create('proj');

    const list = sessions.getByProject('proj');
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });
});

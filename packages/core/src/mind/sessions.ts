/**
 * SessionStore — GOP-scoped session lifecycle management.
 *
 * A "session" groups memory frames under a single `gop_id` (Group Of Perception).
 * Sessions have three states: `active`, `closed`, `archived`. Most callers will
 * want either `create()` (start a new session) or `ensureActive()` (reuse the
 * active session or create one atomically).
 *
 * Extracted from Waggle OS `packages/core/src/mind/sessions.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import type { MindDB } from './db.js';

export interface Session {
  id: number;
  gop_id: string;
  project_id: string | null;
  status: 'active' | 'closed' | 'archived';
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

export class SessionStore {
  private db: MindDB;

  constructor(db: MindDB) {
    this.db = db;
  }

  create(projectId?: string): Session {
    const gopId = `session:${new Date().toISOString()}:${Math.random().toString(36).slice(2, 8)}`;
    const raw = this.db.getDatabase();
    const result = raw
      .prepare(
        `INSERT INTO sessions (gop_id, project_id, status, started_at)
         VALUES (?, ?, 'active', datetime('now'))`,
      )
      .run(gopId, projectId ?? null);
    return raw
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(result.lastInsertRowid) as Session;
  }

  close(gopId: string, summary?: string): Session {
    const raw = this.db.getDatabase();
    raw
      .prepare(
        `UPDATE sessions SET status = 'closed', ended_at = datetime('now'), summary = ?
         WHERE gop_id = ?`,
      )
      .run(summary ?? null, gopId);
    return raw.prepare('SELECT * FROM sessions WHERE gop_id = ?').get(gopId) as Session;
  }

  archive(gopId: string): Session {
    const raw = this.db.getDatabase();
    raw.prepare("UPDATE sessions SET status = 'archived' WHERE gop_id = ?").run(gopId);
    return raw.prepare('SELECT * FROM sessions WHERE gop_id = ?').get(gopId) as Session;
  }

  getByProject(projectId: string): Session[] {
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC')
      .all(projectId) as Session[];
  }

  getActive(): Session[] {
    return this.db
      .getDatabase()
      .prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC")
      .all() as Session[];
  }

  /**
   * Return the most-recent active session, or create one atomically if none
   * exists. Transaction-wrapped so two concurrent callers on a fresh mind
   * produce exactly one session (race-free).
   */
  ensureActive(projectId?: string): Session {
    const raw = this.db.getDatabase();
    const txn = raw.transaction((): Session => {
      // Secondary `id DESC` tiebreak: datetime('now') has second precision, so
      // two create() calls in the same second share started_at and SQLite's
      // ordering becomes unspecified without an explicit tiebreaker.
      const existing = raw
        .prepare(
          "SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC, id DESC LIMIT 1",
        )
        .get() as Session | undefined;
      if (existing) return existing;
      const gopId = `session:${new Date().toISOString()}:${Math.random().toString(36).slice(2, 8)}`;
      const result = raw
        .prepare(
          `INSERT INTO sessions (gop_id, project_id, status, started_at)
           VALUES (?, ?, 'active', datetime('now'))`,
        )
        .run(gopId, projectId ?? null);
      return raw
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(result.lastInsertRowid) as Session;
    });
    return txn();
  }

  getByGopId(gopId: string): Session | undefined {
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM sessions WHERE gop_id = ?')
      .get(gopId) as Session | undefined;
  }

  /**
   * Ensure a session with the given stable gop_id exists, creating it on first
   * use. Useful for long-lived logical sessions (e.g. `harvest`) that group
   * imported memory frames under a single parent across many runs. Unlike
   * `create()` which generates a timestamped id per call, this method is
   * idempotent — repeated calls with the same gop_id return the same session.
   */
  ensure(gopId: string, projectId?: string, summary?: string): Session {
    const existing = this.getByGopId(gopId);
    if (existing) return existing;
    const raw = this.db.getDatabase();
    raw
      .prepare(
        `INSERT INTO sessions (gop_id, project_id, status, summary, started_at)
         VALUES (?, ?, 'active', ?, datetime('now'))`,
      )
      .run(gopId, projectId ?? null, summary ?? null);
    return this.getByGopId(gopId)!;
  }
}

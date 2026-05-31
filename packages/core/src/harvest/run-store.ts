/**
 * HarvestRunStore — tracks the lifecycle of individual harvest commit runs
 * so the UI can surface interrupted runs and offer to resume them.
 *
 * A run is a single harvest commit invocation. States:
 *   running    — commit is executing
 *   completed  — finished successfully
 *   failed     — explicit error; `error_message` is populated
 *   abandoned  — user chose to discard; cache is deleted
 *
 * A "interrupted" run from the UI's perspective is any `running` or `failed`
 * row with a surviving `input_cache_path`. The commit never transitions
 * `running` -> `interrupted` — it simply never finalizes when the client
 * disconnects, so the row stays `running` forever. getLatestInterrupted()
 * surfaces the latest such row.
 *
 * Resume = replay the same input payload; FrameStore.createIFrame dedups
 * on content so already-saved frames become no-ops. No fine-grained
 * checkpoint-offset math needed.
 *
 * Backported verbatim from Waggle OS `packages/hive-mind-core/src/harvest/run-store.ts`.
 * Scrub: none — type-only imports of MindDB + ImportSourceType, no proprietary deps.
 */

import type { MindDB } from '../mind/db.js';
import type { ImportSourceType } from './types.js';

const HARVEST_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS harvest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  total_items INTEGER NOT NULL DEFAULT 0,
  items_saved INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_message TEXT,
  input_cache_path TEXT
);
`;

export type HarvestRunStatus = 'running' | 'completed' | 'failed' | 'abandoned';

export interface HarvestRun {
  id: number;
  source: ImportSourceType;
  status: HarvestRunStatus;
  totalItems: number;
  itemsSaved: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  inputCachePath: string | null;
}

export class HarvestRunStore {
  private db: MindDB;

  constructor(db: MindDB) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    const raw = this.db.getDatabase();
    const existsRow = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='harvest_runs'")
      .get();
    if (!existsRow) {
      raw.exec(HARVEST_RUNS_DDL);
    }
  }

  /**
   * Create a new `running` run record. Caller holds the id for subsequent
   * heartbeat/complete/fail calls.
   */
  start(
    source: ImportSourceType,
    totalItems: number,
    inputCachePath: string | null = null,
  ): HarvestRun {
    const raw = this.db.getDatabase();
    const result = raw
      .prepare(
        `INSERT INTO harvest_runs (source, status, total_items, input_cache_path)
         VALUES (?, 'running', ?, ?)`,
      )
      .run(source, totalItems, inputCachePath);
    return this.getById(Number(result.lastInsertRowid))!;
  }

  /** Update items_saved + updated_at on a running row. No-op on terminal rows. */
  heartbeat(id: number, itemsSaved: number): void {
    const raw = this.db.getDatabase();
    raw
      .prepare(
        `UPDATE harvest_runs SET items_saved = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'running'`,
      )
      .run(itemsSaved, id);
  }

  /** Mark a run completed. Idempotent — no-op on terminal rows. */
  complete(id: number, itemsSaved: number): void {
    const raw = this.db.getDatabase();
    raw
      .prepare(
        `UPDATE harvest_runs SET
           status = 'completed', items_saved = ?,
           updated_at = datetime('now'), finished_at = datetime('now')
         WHERE id = ? AND status = 'running'`,
      )
      .run(itemsSaved, id);
  }

  /** Mark a run failed with an error message. Idempotent — no-op on terminal rows. */
  fail(id: number, errorMessage: string, itemsSaved?: number): void {
    const raw = this.db.getDatabase();
    if (typeof itemsSaved === 'number') {
      raw
        .prepare(
          `UPDATE harvest_runs SET
             status = 'failed', items_saved = ?, error_message = ?,
             updated_at = datetime('now'), finished_at = datetime('now')
           WHERE id = ? AND status = 'running'`,
        )
        .run(itemsSaved, errorMessage.slice(0, 2000), id);
    } else {
      raw
        .prepare(
          `UPDATE harvest_runs SET
             status = 'failed', error_message = ?,
             updated_at = datetime('now'), finished_at = datetime('now')
           WHERE id = ? AND status = 'running'`,
        )
        .run(errorMessage.slice(0, 2000), id);
    }
  }

  /** Mark a run abandoned. Used when the user discards an interrupted run. */
  abandon(id: number): void {
    const raw = this.db.getDatabase();
    raw
      .prepare(
        `UPDATE harvest_runs SET
           status = 'abandoned', updated_at = datetime('now'), finished_at = datetime('now')
         WHERE id = ? AND status IN ('running', 'failed')`,
      )
      .run(id);
  }

  getById(id: number): HarvestRun | null {
    const raw = this.db.getDatabase();
    const row = raw.prepare('SELECT * FROM harvest_runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRun(row) : null;
  }

  /**
   * Latest `running` or `failed` run with a surviving cache path — the UI
   * uses this to offer resume on next page load.
   */
  getLatestInterrupted(): HarvestRun | null {
    const raw = this.db.getDatabase();
    const row = raw
      .prepare(
        `SELECT * FROM harvest_runs
         WHERE status IN ('running', 'failed') AND input_cache_path IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : null;
  }

  /** All runs, newest first — useful for debugging and future history views. */
  getAll(limit = 50): HarvestRun[] {
    const raw = this.db.getDatabase();
    return (
      raw
        .prepare('SELECT * FROM harvest_runs ORDER BY started_at DESC LIMIT ?')
        .all(limit) as Record<string, unknown>[]
    ).map((r) => this.rowToRun(r));
  }

  private rowToRun(row: Record<string, unknown>): HarvestRun {
    return {
      id: row.id as number,
      source: row.source as ImportSourceType,
      status: row.status as HarvestRunStatus,
      totalItems: row.total_items as number,
      itemsSaved: row.items_saved as number,
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
      finishedAt: (row.finished_at as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      inputCachePath: (row.input_cache_path as string | null) ?? null,
    };
  }
}

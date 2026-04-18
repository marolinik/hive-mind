/**
 * HarvestSourceStore — tracks connected harvest sources and sync state.
 *
 * Persists one row per registered source (ChatGPT, Claude, Gemini, local
 * files, URLs, ...) with sync bookkeeping: last-synced timestamp,
 * items/frames imported counters, auto-sync toggle, and content-hash
 * snapshot for change detection.
 *
 * Self-bootstraps its `harvest_sources` table via the constructor — no
 * schema.ts entry needed; consumers that don't harvest never pay the
 * table cost (mirrors the ConceptTracker pattern).
 *
 * Extracted from Waggle OS `packages/core/src/harvest/source-store.ts`.
 * Scrub: none — this module has no proprietary dependencies. The Waggle
 * source created the table via multi-statement SQL apply; here we use
 * prepare+run since the DDL is a single CREATE TABLE (mirrors the
 * single-statement pattern used in awareness.ts).
 */

import type { MindDB } from '../mind/db.js';
import type { HarvestSource, ImportSourceType } from './types.js';

const HARVEST_SOURCES_DDL = `
CREATE TABLE IF NOT EXISTS harvest_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  source_path TEXT,
  last_synced_at TEXT,
  items_imported INTEGER NOT NULL DEFAULT 0,
  frames_created INTEGER NOT NULL DEFAULT 0,
  auto_sync INTEGER NOT NULL DEFAULT 0,
  sync_interval_hours INTEGER NOT NULL DEFAULT 24,
  last_content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export class HarvestSourceStore {
  private db: MindDB;

  constructor(db: MindDB) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    const raw = this.db.getDatabase();
    const exists = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='harvest_sources'")
      .get();
    if (!exists) {
      raw.prepare(HARVEST_SOURCES_DDL).run();
    }
  }

  /** Register or update a harvest source. */
  upsert(
    source: ImportSourceType,
    displayName: string,
    sourcePath?: string,
  ): HarvestSource {
    const raw = this.db.getDatabase();

    raw
      .prepare(
        `INSERT INTO harvest_sources (source, display_name, source_path)
         VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           display_name = excluded.display_name,
           source_path = COALESCE(excluded.source_path, harvest_sources.source_path)`,
      )
      .run(source, displayName, sourcePath ?? null);

    return this.getBySource(source)!;
  }

  /** Record a completed sync. */
  recordSync(
    source: ImportSourceType,
    itemsImported: number,
    framesCreated: number,
    contentHash?: string,
  ): void {
    const raw = this.db.getDatabase();
    raw
      .prepare(
        `UPDATE harvest_sources SET
           last_synced_at = datetime('now'),
           items_imported = items_imported + ?,
           frames_created = frames_created + ?,
           last_content_hash = COALESCE(?, last_content_hash)
         WHERE source = ?`,
      )
      .run(itemsImported, framesCreated, contentHash ?? null, source);
  }

  /** Enable or disable auto-sync for a source. */
  setAutoSync(source: ImportSourceType, enabled: boolean, intervalHours?: number): void {
    const raw = this.db.getDatabase();
    raw
      .prepare(
        `UPDATE harvest_sources SET
           auto_sync = ?,
           sync_interval_hours = COALESCE(?, sync_interval_hours)
         WHERE source = ?`,
      )
      .run(enabled ? 1 : 0, intervalHours ?? null, source);
  }

  /** Get a specific source. */
  getBySource(source: ImportSourceType): HarvestSource | null {
    const raw = this.db.getDatabase();
    const row = raw
      .prepare('SELECT * FROM harvest_sources WHERE source = ?')
      .get(source) as Record<string, unknown> | undefined;
    return row ? this.rowToSource(row) : null;
  }

  /** Get all registered sources. */
  getAll(): HarvestSource[] {
    const raw = this.db.getDatabase();
    return (
      raw
        .prepare('SELECT * FROM harvest_sources ORDER BY last_synced_at DESC')
        .all() as Record<string, unknown>[]
    ).map((r) => this.rowToSource(r));
  }

  /** Get sources that need syncing (auto_sync enabled and interval elapsed). */
  getStale(): HarvestSource[] {
    const raw = this.db.getDatabase();
    return (
      raw
        .prepare(
          `SELECT * FROM harvest_sources
           WHERE auto_sync = 1
             AND (last_synced_at IS NULL
                  OR datetime(last_synced_at, '+' || sync_interval_hours || ' hours') <= datetime('now'))`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => this.rowToSource(r));
  }

  /** Remove a source. */
  remove(source: ImportSourceType): void {
    this.db
      .getDatabase()
      .prepare('DELETE FROM harvest_sources WHERE source = ?')
      .run(source);
  }

  private rowToSource(row: Record<string, unknown>): HarvestSource {
    return {
      id: row.id as number,
      source: row.source as ImportSourceType,
      displayName: row.display_name as string,
      sourcePath: row.source_path as string | null,
      lastSyncedAt: row.last_synced_at as string | null,
      itemsImported: row.items_imported as number,
      framesCreated: row.frames_created as number,
      autoSync: (row.auto_sync as number) === 1,
      syncIntervalHours: row.sync_interval_hours as number,
      lastContentHash: row.last_content_hash as string | null,
      createdAt: row.created_at as string,
    };
  }
}

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SCHEMA_SQL, VEC_TABLE_SQL, SCHEMA_VERSION } from './schema.js';

/**
 * MindDB — the SQLite-backed memory substrate for hive-mind.
 *
 * One instance per `.mind` file. Applies the bundled schema on first run and
 * idempotent migrations on subsequent opens. WAL mode and foreign keys are
 * enabled by default for concurrent read performance and referential integrity.
 *
 * sqlite-vec is loaded via the npm package in the default case. Downstream
 * distributions that bundle a platform-specific binary (for example Tauri
 * desktop builds) can point `HIVE_MIND_SQLITE_VEC_PATH` at that binary to skip
 * the npm resolver.
 */
export class MindDB {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    const vecPath = process.env.HIVE_MIND_SQLITE_VEC_PATH;
    if (vecPath) {
      this.db.loadExtension(vecPath);
    } else {
      sqliteVec.load(this.db);
    }

    this.initSchema();
  }

  private initSchema(): void {
    const existing = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .get() as { name: string } | undefined;

    if (!existing) {
      this.applySql(SCHEMA_SQL);
      this.applySql(VEC_TABLE_SQL);
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(SCHEMA_VERSION);
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('first_run_at', ?)")
        .run(new Date().toISOString());
    } else {
      this.runMigrations();
      const hasFirstRun = this.db
        .prepare("SELECT value FROM meta WHERE key = 'first_run_at'")
        .get() as { value: string } | undefined;
      if (!hasFirstRun) {
        this.db
          .prepare("INSERT INTO meta (key, value) VALUES ('first_run_at', ?)")
          .run(new Date().toISOString());
      }
    }
  }

  /** Read the first-run timestamp for this database (ISO 8601). Returns null if missing. */
  getFirstRunAt(): string | null {
    try {
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'first_run_at'")
        .get() as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private applySql(sql: string): void {
    this.db.exec(sql);
  }

  private runMigrations(): void {
    // SCHEMA_SQL uses CREATE TABLE/INDEX IF NOT EXISTS throughout, so re-running
    // it against an existing database is safe and idempotent — it only creates
    // what's missing. This handles the case where a new release introduces new
    // tables that older .mind databases haven't seen yet.
    this.applySql(SCHEMA_SQL);

    // Provenance: `memory_frames.source` was added after the initial release.
    // Old frames default to 'user_stated' which is the correct fallback for
    // frames persisted before provenance tracking existed.
    const hasSourceCol = this.db
      .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('memory_frames') WHERE name='source'")
      .get() as { cnt: number };
    if (hasSourceCol.cnt === 0) {
      this.applySql(
        "ALTER TABLE memory_frames ADD COLUMN source TEXT NOT NULL DEFAULT 'user_stated'"
      );
    }
  }

  getDatabase(): DatabaseType {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

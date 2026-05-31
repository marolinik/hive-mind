import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SCHEMA_SQL, VEC_TABLE_SQL, SCHEMA_VERSION } from './schema.js';
import { hashFrameContent } from './content-hash.js';

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
    // Add columns that post-date older .mind files BEFORE re-applying SCHEMA_SQL.
    // SCHEMA_SQL now creates idx_frames_content_hash over memory_frames.content_hash,
    // so that column must exist first or the index creation throws "no such column".
    //
    // Provenance: `memory_frames.source` was added after the initial release.
    // Old frames default to 'user_stated' (correct fallback for pre-provenance frames).
    this.ensureColumn('memory_frames', 'source', "TEXT NOT NULL DEFAULT 'user_stated'");
    // Dedup: `content_hash` backs the indexed dedup lookup (replaces the last-500 scan).
    this.ensureColumn('memory_frames', 'content_hash', 'TEXT');

    // SCHEMA_SQL uses CREATE TABLE/INDEX IF NOT EXISTS throughout, so re-running
    // it against an existing database is safe and idempotent — it only creates
    // what's missing (now including idx_frames_content_hash, after the column add).
    this.applySql(SCHEMA_SQL);

    // VEC_TABLE_SQL also uses IF NOT EXISTS — re-applying ensures new vec
    // tables (e.g. memory_frame_chunks_vec added in semantic-chunking work)
    // get created on databases that predate them, while leaving existing
    // memory_frames_vec untouched.
    this.applySql(VEC_TABLE_SQL);

    // One-time backfill: populate content_hash for legacy rows that predate the
    // column. Gated on the column being newly NULL, so it runs once per upgrade.
    this.backfillContentHash();
  }

  /** Add a column to a table only if it isn't already present (idempotent migration). */
  private ensureColumn(table: string, column: string, defn: string): void {
    const present = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM pragma_table_info('${table}') WHERE name = ?`)
      .get(column) as { cnt: number };
    if (present.cnt === 0) {
      this.applySql(`ALTER TABLE ${table} ADD COLUMN ${column} ${defn}`);
    }
  }

  /** Backfill memory_frames.content_hash for rows inserted before the column existed. */
  private backfillContentHash(): void {
    const rows = this.db
      .prepare('SELECT id, content FROM memory_frames WHERE content_hash IS NULL')
      .all() as { id: number; content: string }[];
    if (rows.length === 0) return;
    const update = this.db.prepare('UPDATE memory_frames SET content_hash = ? WHERE id = ?');
    const tx = this.db.transaction((items: { id: number; content: string }[]) => {
      for (const r of items) update.run(hashFrameContent(r.content), r.id);
    });
    tx(rows);
  }

  getDatabase(): DatabaseType {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

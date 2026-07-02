import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SCHEMA_SQL, VEC_TABLE_SQL, SCHEMA_VERSION, vecTableSqlForDim } from './schema.js';
import { hashFrameContent } from './content-hash.js';

/** A persisted embedding fingerprint: which provider/model produced this .mind's
 *  vectors, and at what dimension. Recorded in `meta` on the first vector write. */
export interface EmbeddingFingerprint {
  provider: string;
  model: string;
  dim: number;
}

export type FingerprintCheck =
  | { status: 'recorded' }
  | { status: 'match' }
  | { status: 'model-changed'; storedModel: string; storedProvider: string };

/** Thrown when the active embedder's dimension differs from the dimension this
 *  .mind's vectors were written at. Mixing dims returns noise and corrupts the
 *  index, so we refuse loudly and point at the re-embed remediation. */
export class EmbeddingDimMismatchError extends Error {
  constructor(
    readonly storedDim: number,
    readonly runtimeDim: number,
  ) {
    super(
      `Embedding dimension mismatch: this .mind stores ${storedDim}-dim vectors but the active ` +
        `embedder produces ${runtimeDim}-dim vectors. Vector search would return noise and writes ` +
        `would corrupt the index. Re-embed at the new dimension with \`hive-mind maintenance --reembed\`, ` +
        `or switch back to a ${storedDim}-dim model.`,
    );
    this.name = 'EmbeddingDimMismatchError';
  }
}

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
      // Fresh databases are born under the hm-stripped hash semantics, so the
      // one-time rehash in runMigrations() never needs to run for them.
      // Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('content_hash_semantics', 'hm-stripped')")
        .run();
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

  /** Read a single `meta` value, or null if absent. */
  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Upsert a single `meta` key/value (meta.key is the PRIMARY KEY). */
  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /**
   * Guard this .mind's embedding fingerprint. Call before the first vector
   * write/read of a session (HybridSearch is the natural seam — it holds both
   * the db and the embedder). Returns the check result; throws only on a hard
   * dimension mismatch:
   *   - no fingerprint yet → record {provider, model, dim}, return 'recorded'
   *   - same dim + same model → 'match' (no-op)
   *   - same dim, different model/provider → update + 'model-changed' (caller
   *     should warn: vectors stay numerically valid but cross-model comparison
   *     is semantically degraded)
   *   - different dim → throw EmbeddingDimMismatchError (only safe path is re-embed)
   */
  ensureEmbeddingFingerprint(fp: EmbeddingFingerprint): FingerprintCheck {
    const storedDimRaw = this.getMeta('embedding_dim');
    if (storedDimRaw === null) {
      this.setMeta('embedding_provider', fp.provider);
      this.setMeta('embedding_model', fp.model);
      this.setMeta('embedding_dim', String(fp.dim));
      return { status: 'recorded' };
    }
    const storedDim = Number(storedDimRaw);
    if (storedDim !== fp.dim) {
      throw new EmbeddingDimMismatchError(storedDim, fp.dim);
    }
    const storedModel = this.getMeta('embedding_model') ?? '';
    const storedProvider = this.getMeta('embedding_provider') ?? '';
    if (storedModel !== fp.model || storedProvider !== fp.provider) {
      this.setMeta('embedding_provider', fp.provider);
      this.setMeta('embedding_model', fp.model);
      return { status: 'model-changed', storedModel, storedProvider };
    }
    return { status: 'match' };
  }

  /** Force-write the embedding fingerprint. Used after a re-embed so the guard
   *  matches the embedder that produced the new vectors. */
  setEmbeddingFingerprint(fp: EmbeddingFingerprint): void {
    this.setMeta('embedding_provider', fp.provider);
    this.setMeta('embedding_model', fp.model);
    this.setMeta('embedding_dim', String(fp.dim));
  }

  /** Read the recorded embedding fingerprint, or null if none recorded yet. */
  getEmbeddingFingerprint(): EmbeddingFingerprint | null {
    const dimRaw = this.getMeta('embedding_dim');
    if (dimRaw === null) return null;
    return {
      provider: this.getMeta('embedding_provider') ?? 'unknown',
      model: this.getMeta('embedding_model') ?? 'unknown',
      dim: Number(dimRaw),
    };
  }

  /**
   * DROP + CREATE both vec tables at `dim` (vec0 columns can't be ALTERed) and
   * update the stored dim. DESTRUCTIVE — existing vectors are discarded; the
   * caller re-embeds afterward (maintenance --reembed-all / --rechunk-all). This
   * is the remediation for an EmbeddingDimMismatchError.
   */
  recreateVecTables(dim: number): void {
    const d = Math.trunc(dim);
    const tx = this.db.transaction(() => {
      this.db.exec(
        'DROP TABLE IF EXISTS memory_frames_vec; DROP TABLE IF EXISTS memory_frame_chunks_vec;',
      );
      this.db.exec(vecTableSqlForDim(d));
      this.setMeta('embedding_dim', String(d));
    });
    tx();
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
    // Per-frame metadata JSON blob (provenance/classification; backs raw_archive
    // linking via metadata.archiveUids). Idempotent additive column.
    this.ensureColumn('memory_frames', 'metadata', "TEXT NOT NULL DEFAULT '{}'");

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

    // One-time rehash: hashFrameContent changed from trim-only to
    // stripHmPrefix + trim (provenance-insensitive dedup — mono-parity
    // 2026-06-12). Rows hashed under the old semantics would never match new
    // lookups for `[hm …]`-prefixed content, so recompute every row once.
    // Idempotence: guarded by the meta flag 'content_hash_semantics'.
    this.rehashContentHashes();

    // #7 (2026-06-30): verbatim provenance archive — append-only, immutable.
    // Idempotent; SCHEMA_SQL carries the same DDL for fresh DBs. Not in the
    // retrieval corpus (no FTS/vec). Append-only triggers, EXCEPT a one-time GDPR
    // Art.17 redaction (see raw_archive_no_update WHEN clause).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_uid TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        source_ref TEXT,
        title TEXT,
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        injection_flagged INTEGER NOT NULL DEFAULT 0,
        injection_flags TEXT NOT NULL DEFAULT '',
        source_timestamp TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        erased_at TEXT,
        erased_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_raw_archive_source_ref ON raw_archive (source, source_ref);
      CREATE INDEX IF NOT EXISTS idx_raw_archive_created ON raw_archive (created_at DESC);
    `);
    // GDPR Art.17 columns for pre-erasure DBs (idempotent ADD COLUMN). MUST precede
    // the trigger below, which references NEW.erased_at / OLD.erased_at. ALTER is DDL
    // — it does NOT fire the BEFORE UPDATE trigger.
    for (const col of ['erased_at', 'erased_reason'] as const) {
      const has = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM pragma_table_info('raw_archive') WHERE name=?"
      ).get(col) as { cnt: number };
      if (has.cnt === 0) {
        this.db.exec(`ALTER TABLE raw_archive ADD COLUMN ${col} TEXT`);
      }
    }
    // Upgrade the legacy ABSOLUTE no-update trigger to the redaction-aware one.
    // CREATE TRIGGER IF NOT EXISTS will NOT swap an existing trigger, so we DROP +
    // CREATE — but ATOMICALLY (one transaction), else a crash or a concurrent WAL
    // writer between the two statements would see raw_archive with NO update guard.
    // Sentinel: skip once the live trigger already carries the archive_uid-ROTATION
    // clause. An OLD trigger that still froze archive_uid ('IS OLD.archive_uid') lacks
    // this substring, so it is upgraded on reopen — required, else the rotating erase()
    // would be rejected on an existing DB. The WHEN clause is kept BYTE-IDENTICAL to the
    // SCHEMA_SQL version in schema.ts, and the content literal to
    // RAW_ARCHIVE_REDACTION_MARKER in raw-archive.ts. (Forward-only: this does NOT
    // rotate the uid of rows erased under the old trigger — the trigger only permits
    // rotation during the one-time erased_at NULL->set transition.)
    const liveNoUpdate = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='raw_archive_no_update'"
    ).get() as { sql?: string } | undefined;
    if (!liveNoUpdate?.sql || !liveNoUpdate.sql.includes('NEW.archive_uid <> OLD.archive_uid')) {
      this.db.transaction(() => {
        this.db.exec('DROP TRIGGER IF EXISTS raw_archive_no_update');
        this.db.exec(
          "CREATE TRIGGER raw_archive_no_update BEFORE UPDATE ON raw_archive " +
          "WHEN NOT (OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND NEW.erased_at <> '' " +
          "AND NEW.content = '[REDACTED — GDPR Art.17 erasure]' AND NEW.content_sha256 = '' AND NEW.title IS NULL " +
          "AND NEW.id IS OLD.id AND NEW.archive_uid <> OLD.archive_uid AND NEW.archive_uid <> '' " +
          "AND NEW.source IS OLD.source AND NEW.source_ref IS OLD.source_ref " +
          "AND NEW.created_at IS OLD.created_at AND NEW.source_timestamp IS OLD.source_timestamp " +
          "AND NEW.injection_flagged IS OLD.injection_flagged AND NEW.injection_flags IS OLD.injection_flags) " +
          "BEGIN SELECT RAISE(ABORT, 'raw_archive is append-only; only a one-time canonical GDPR Art.17 redaction is permitted'); END"
        );
      })();
    }
    this.db.exec(
      "CREATE TRIGGER IF NOT EXISTS raw_archive_no_delete BEFORE DELETE ON raw_archive BEGIN SELECT RAISE(ABORT, 'raw_archive is append-only (verbatim provenance archive)'); END"
    );

    // One-time backfill of the kg_entity_frames bridge over pre-existing frames
    // so the 'contextual' scoring signal works retroactively. Sentinel-guarded.
    this.backfillKgEntityFrames();
  }

  /** Recompute content_hash for ALL rows under the current hashFrameContent
   *  semantics (hm-stripped + trimmed). Runs once per database — guarded by
   *  the 'content_hash_semantics' meta flag. Transactional.
   *  Forward-ported from waggle-os monorepo (mono-parity 2026-06-12). */
  private rehashContentHashes(): void {
    if (this.getMeta('content_hash_semantics') === 'hm-stripped') return;
    const rows = this.db
      .prepare('SELECT id, content FROM memory_frames')
      .all() as { id: number; content: string }[];
    const update = this.db.prepare('UPDATE memory_frames SET content_hash = ? WHERE id = ?');
    const tx = this.db.transaction((items: { id: number; content: string }[]) => {
      for (const r of items) update.run(hashFrameContent(r.content), r.id);
      this.setMeta('content_hash_semantics', 'hm-stripped');
    });
    tx(rows);
  }

  /** One-time backfill of the kg_entity_frames bridge so the 'contextual' scoring
   *  signal works over frames written before the bridge existed. Offline (string
   *  match, no LLM): an entity links to a frame whose content mentions its name.
   *  Idempotent (INSERT OR IGNORE) and guarded by a meta sentinel unless `force`.
   *  Returns the number of new (entity, frame) links created. */
  backfillKgEntityFrames(force = false): number {
    if (!force && this.getMeta('kg_bridge_backfilled') === '1') return 0;
    const frames = this.db
      .prepare('SELECT id, content FROM memory_frames')
      .all() as { id: number; content: string }[];
    // Ubiquity cap: an entity mentioned in nearly every frame (e.g. "Claude" in a
    // claude-code export) is a hub that carries no locational signal — skip it.
    // Cap at 40% of frames, floored at 20 so small corpora aren't over-filtered.
    const cap = Math.max(20, Math.floor(frames.length * 0.4));
    const ents = this.db
      .prepare("SELECT id, lower(name) AS lname FROM knowledge_entities WHERE valid_to IS NULL AND length(name) >= 3")
      .all() as { id: number; lname: string }[];
    const countStmt = this.db.prepare(
      'SELECT COUNT(*) AS c FROM memory_frames WHERE instr(lower(content), ?) > 0',
    );
    const keep = ents.filter((e) => {
      const c = (countStmt.get(e.lname) as { c: number }).c;
      return c > 0 && c <= cap;
    });
    const link = this.db.prepare(
      'INSERT OR IGNORE INTO kg_entity_frames (entity_id, frame_id) VALUES (?, ?)',
    );
    let created = 0;
    const tx = this.db.transaction(() => {
      // On a forced re-run, rebuild from scratch so hub/merged entities don't linger.
      if (force) this.db.prepare('DELETE FROM kg_entity_frames').run();
      for (const f of frames) {
        const lc = f.content.toLowerCase();
        for (const e of keep) {
          if (lc.includes(e.lname)) created += link.run(e.id, f.id).changes;
        }
      }
      this.setMeta('kg_bridge_backfilled', '1');
    });
    tx();
    return created;
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

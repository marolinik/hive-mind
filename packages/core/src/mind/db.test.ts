import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MindDB, EmbeddingDimMismatchError } from './db.js';
import { hashFrameContent } from './content-hash.js';

describe('MindDB', () => {
  let dbPath: string;
  let db: MindDB | null;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hive-mind-test-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
  });

  afterEach(() => {
    db?.close();
    db = null;
    if (existsSync(dbPath)) rmSync(dbPath);
    // better-sqlite3 creates -shm and -wal sidecar files in WAL mode
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('initializes schema and records a first_run_at timestamp on first open', () => {
    const firstRun = db!.getFirstRunAt();
    expect(firstRun).not.toBeNull();
    expect(() => new Date(firstRun!).toISOString()).not.toThrow();
  });

  it('creates the expected OSS tables and omits the proprietary ones', () => {
    const raw = db!.getDatabase();
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));

    // Core OSS surface — must exist
    for (const expected of [
      'meta',
      'identity',
      'awareness',
      'sessions',
      'memory_frames',
      'knowledge_entities',
      'knowledge_relations',
      'harvest_sources',
      'raw_archive',
    ]) {
      expect(names.has(expected), `expected table ${expected}`).toBe(true);
    }

    // Proprietary surface — must be absent
    for (const excluded of [
      'ai_interactions',
      'execution_traces',
      'evolution_runs',
      'improvement_signals',
      'procedures',
      'install_audit',
    ]) {
      expect(names.has(excluded), `proprietary table ${excluded} must be absent`).toBe(false);
    }
  });

  it('supports the memory_frames + FTS5 + sqlite-vec pipeline', () => {
    const raw = db!.getDatabase();

    raw.prepare(
      "INSERT INTO sessions (gop_id, project_id) VALUES (?, ?)"
    ).run('gop-1', 'test-project');

    const insert = raw.prepare(
      `INSERT INTO memory_frames (frame_type, gop_id, content, importance, source)
       VALUES (?, ?, ?, ?, ?)`
    );
    insert.run('I', 'gop-1', 'User prefers TypeScript over JavaScript', 'important', 'user_stated');
    insert.run('I', 'gop-1', 'User uses vitest for testing', 'normal', 'user_stated');

    const countRow = raw
      .prepare('SELECT COUNT(*) as n FROM memory_frames')
      .get() as { n: number };
    expect(countRow.n).toBe(2);

    // vec0 virtual table accepts float[1024] embeddings. rowid must be
    // interpolated literally — vec0 rejects parameter-bound rowids.
    const embedding = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) embedding[i] = Math.random();
    const embeddingBlob = new Uint8Array(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength
    );
    raw.prepare(
      `INSERT INTO memory_frames_vec (rowid, embedding) VALUES (1, ?)`
    ).run(embeddingBlob);

    const vecCountRow = raw
      .prepare('SELECT COUNT(*) as n FROM memory_frames_vec')
      .get() as { n: number };
    expect(vecCountRow.n).toBe(1);
  });

  it('runs migrations idempotently when reopening an existing database', () => {
    db!.close();
    db = new MindDB(dbPath);
    // No throw = migrations re-applied cleanly against existing schema.
    expect(db.getFirstRunAt()).not.toBeNull();
  });

  it('ensureEmbeddingFingerprint records the fingerprint on first call, then matches', () => {
    const first = db!.ensureEmbeddingFingerprint({ provider: 'voyage', model: 'voyage-3-lite', dim: 1024 });
    expect(first.status).toBe('recorded');
    const second = db!.ensureEmbeddingFingerprint({ provider: 'voyage', model: 'voyage-3-lite', dim: 1024 });
    expect(second.status).toBe('match');
  });

  it('ensureEmbeddingFingerprint throws EmbeddingDimMismatchError on a dimension change', () => {
    db!.ensureEmbeddingFingerprint({ provider: 'voyage', model: 'voyage-3-lite', dim: 1024 });
    expect(() =>
      db!.ensureEmbeddingFingerprint({ provider: 'ollama', model: 'nomic-embed-text', dim: 768 }),
    ).toThrow(EmbeddingDimMismatchError);
    try {
      db!.ensureEmbeddingFingerprint({ provider: 'ollama', model: 'nomic-embed-text', dim: 768 });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('1024'); // stored dim
      expect(msg).toContain('768'); // runtime dim
      expect(msg).toMatch(/reembed/i); // points at the remediation
    }
  });

  it('recreateVecTables rebuilds the vec tables at a new dimension', () => {
    const raw = db!.getDatabase();
    const v1024 = new Float32Array(1024);
    raw
      .prepare('INSERT INTO memory_frames_vec (rowid, embedding) VALUES (1, ?)')
      .run(new Uint8Array(v1024.buffer));
    expect((raw.prepare('SELECT COUNT(*) n FROM memory_frames_vec').get() as { n: number }).n).toBe(1);

    db!.recreateVecTables(768);

    // Old rows are gone and the column is now 768-dim.
    expect((raw.prepare('SELECT COUNT(*) n FROM memory_frames_vec').get() as { n: number }).n).toBe(0);
    const v768 = new Float32Array(768);
    expect(() =>
      raw
        .prepare('INSERT INTO memory_frames_vec (rowid, embedding) VALUES (2, ?)')
        .run(new Uint8Array(v768.buffer)),
    ).not.toThrow();
    expect(() =>
      raw
        .prepare('INSERT INTO memory_frames_vec (rowid, embedding) VALUES (3, ?)')
        .run(new Uint8Array(v1024.buffer)),
    ).toThrow(); // 1024 no longer fits the 768 column
    // The stored dim fingerprint follows the recreation.
    expect(db!.getEmbeddingFingerprint()?.dim).toBe(768);
  });

  it('setEmbeddingFingerprint / getEmbeddingFingerprint round-trip', () => {
    expect(db!.getEmbeddingFingerprint()).toBeNull();
    db!.setEmbeddingFingerprint({ provider: 'ollama', model: 'nomic-embed-text', dim: 768 });
    expect(db!.getEmbeddingFingerprint()).toEqual({
      provider: 'ollama',
      model: 'nomic-embed-text',
      dim: 768,
    });
  });

  // ── content_hash semantics migration (mono-parity 2026-06-12) ───────────
  // hashFrameContent changed from trim-only to stripHmPrefix + trim. Legacy
  // databases carry trim-only hashes; runMigrations() must rehash every row
  // once, guarded by the 'content_hash_semantics' meta flag.

  it('marks fresh databases with content_hash_semantics = hm-stripped (no rehash needed)', () => {
    const flag = db!
      .getDatabase()
      .prepare("SELECT value FROM meta WHERE key = 'content_hash_semantics'")
      .get() as { value: string } | undefined;
    expect(flag?.value).toBe('hm-stripped');
  });

  it('rehashes legacy trim-only content_hash values on open and sets the meta flag', () => {
    const raw = db!.getDatabase();
    raw.prepare('INSERT INTO sessions (gop_id, project_id) VALUES (?, ?)').run('gop-1', 'p');
    const content = '[hm session:abc src:claude-code] the actual body';
    // Legacy semantics: sha256 over content.trim() WITHOUT stripping the prefix.
    const legacyHash = createHash('sha256').update(content.trim()).digest('hex');
    raw
      .prepare(
        `INSERT INTO memory_frames (frame_type, gop_id, content, importance, source, content_hash)
         VALUES ('I', 'gop-1', ?, 'normal', 'user_stated', ?)`,
      )
      .run(content, legacyHash);
    // Simulate a pre-migration database: flag absent.
    raw.prepare("DELETE FROM meta WHERE key = 'content_hash_semantics'").run();
    db!.close();

    db = new MindDB(dbPath);
    const row = db
      .getDatabase()
      .prepare('SELECT content_hash FROM memory_frames WHERE content = ?')
      .get(content) as { content_hash: string };
    expect(row.content_hash).toBe(hashFrameContent(content)); // hm-stripped semantics
    expect(row.content_hash).not.toBe(legacyHash);
    const flag = db
      .getDatabase()
      .prepare("SELECT value FROM meta WHERE key = 'content_hash_semantics'")
      .get() as { value: string } | undefined;
    expect(flag?.value).toBe('hm-stripped');
  });

  it('rehash is idempotent: a second open under the flag leaves hashes untouched', () => {
    const raw = db!.getDatabase();
    raw.prepare('INSERT INTO sessions (gop_id, project_id) VALUES (?, ?)').run('gop-1', 'p');
    raw
      .prepare(
        `INSERT INTO memory_frames (frame_type, gop_id, content, importance, source, content_hash)
         VALUES ('I', 'gop-1', 'stable body', 'normal', 'user_stated', ?)`,
      )
      .run(hashFrameContent('stable body'));
    db!.close();

    db = new MindDB(dbPath); // flag already 'hm-stripped' → rehash skipped
    const row = db
      .getDatabase()
      .prepare("SELECT content_hash FROM memory_frames WHERE content = 'stable body'")
      .get() as { content_hash: string };
    expect(row.content_hash).toBe(hashFrameContent('stable body'));
  });

  it('ensureEmbeddingFingerprint warns but ALLOWS a same-dim model change', () => {
    db!.ensureEmbeddingFingerprint({ provider: 'voyage', model: 'voyage-3-lite', dim: 1024 });
    const changed = db!.ensureEmbeddingFingerprint({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dim: 1024,
    });
    expect(changed.status).toBe('model-changed');
    expect(changed.storedModel).toBe('voyage-3-lite');
    // Fingerprint is updated to the new model, so a repeat now matches.
    const after = db!.ensureEmbeddingFingerprint({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dim: 1024,
    });
    expect(after.status).toBe('match');
  });
});

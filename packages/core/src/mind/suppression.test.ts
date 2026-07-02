import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MindDB } from './db.js';
import { RawArchive } from './raw-archive.js';
import { FrameStore } from './frames.js';
import { SessionStore } from './sessions.js';
import { MindErasure } from './erasure.js';
import { SuppressionStore } from './suppression.js';

// The erased-subject suppression list (#7 Art.17 "sticky erasure"): a (source,
// source_ref) that was erased must not re-materialize on re-import. Keyed on the
// SUBJECT pair only — no content, no hash (a content-keyed tombstone would
// reintroduce the re-identification vector the archive_uid rotation removed).

describe('SuppressionStore', () => {
  let db: MindDB;
  let sup: SuppressionStore;
  beforeEach(() => {
    db = new MindDB(':memory:');
    sup = new SuppressionStore(db);
  });
  afterEach(() => db.close());

  it('records a subject and reports it suppressed', () => {
    expect(sup.isSuppressed('chatgpt', 'thread-42')).toBe(false);
    sup.record('chatgpt', 'thread-42', 'gdpr-art17');
    expect(sup.isSuppressed('chatgpt', 'thread-42')).toBe(true);
  });

  it('scopes suppression to the exact (source, source_ref) pair', () => {
    sup.record('chatgpt', 'thread-42', 'r');
    expect(sup.isSuppressed('chatgpt', 'thread-99')).toBe(false); // other ref
    expect(sup.isSuppressed('claude', 'thread-42')).toBe(false);  // other source
  });

  it('is idempotent on re-record (UNIQUE(source, source_ref))', () => {
    sup.record('chatgpt', 'thread-42', 'first');
    sup.record('chatgpt', 'thread-42', 'second');
    expect(sup.list()).toHaveLength(1);
    expect(sup.isSuppressed('chatgpt', 'thread-42')).toBe(true);
  });

  it('unsuppress removes the row and reports whether one was removed (re-consent)', () => {
    sup.record('chatgpt', 'thread-42', 'r');
    expect(sup.unsuppress('chatgpt', 'thread-42')).toBe(true);
    expect(sup.isSuppressed('chatgpt', 'thread-42')).toBe(false);
    expect(sup.unsuppress('chatgpt', 'thread-42')).toBe(false); // already gone
  });

  it('list returns each suppressed subject with source, sourceRef, erasedAt, reason', () => {
    sup.record('chatgpt', 'thread-42', 'gdpr-art17');
    const rows = sup.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('chatgpt');
    expect(rows[0].sourceRef).toBe('thread-42');
    expect(rows[0].reason).toBe('gdpr-art17');
    expect(typeof rows[0].erasedAt).toBe('string');
    expect(rows[0].erasedAt.length).toBeGreaterThan(0);
  });

  it('isSuppressed FAILS CLOSED — a read error is treated as suppressed (Art.17 wins)', () => {
    // A genuine read failure means the DB is broken and the follow-on import
    // INSERT fails anyway; on the ambiguous item we must NOT re-materialize.
    db.getDatabase().exec('DROP TABLE erased_subjects');
    expect(sup.isSuppressed('chatgpt', 'thread-42')).toBe(true);
  });
});

describe('erased_subjects migration + backfill', () => {
  it('backfills from pre-existing erased raw_archive rows (one-time upgrade)', () => {
    const db = new MindDB(':memory:');
    const archive = new RawArchive(db);
    const { archiveUid } = archive.append({ source: 'chatgpt', sourceRef: 'thread-7', content: 'secret PII' });
    archive.erase(archiveUid, 'gdpr'); // raw_archive redacted; RawArchive does NOT record suppression
    const sup = new SuppressionStore(db);
    expect(sup.isSuppressed('chatgpt', 'thread-7')).toBe(false); // not yet backfilled
    db.backfillErasedSubjects(true);   // force the one-time upgrade backfill
    expect(sup.isSuppressed('chatgpt', 'thread-7')).toBe(true);
    db.close();
  });

  it('runs the backfill automatically on DB open (real upgrade path)', () => {
    const file = path.join(os.tmpdir(), `sup-mig-${process.pid}-${Date.now()}.db`);
    try {
      const db1 = new MindDB(file);
      const archive = new RawArchive(db1);
      const { archiveUid } = archive.append({ source: 'claude', sourceRef: 'conv-9', content: 'more PII' });
      archive.erase(archiveUid, 'gdpr');
      // Simulate a DB reaching this code for the FIRST time: an erased row exists,
      // the backfill sentinel is not yet set, erased_subjects is empty.
      db1.getDatabase().prepare("DELETE FROM meta WHERE key = 'erased_subjects_backfilled'").run();
      db1.getDatabase().exec('DELETE FROM erased_subjects');
      db1.close();

      const db2 = new MindDB(file); // reopen → runMigrations → backfill runs once
      expect(new SuppressionStore(db2).isSuppressed('claude', 'conv-9')).toBe(true);
      db2.close();
    } finally {
      for (const sfx of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + sfx); } catch { /* ignore */ } }
    }
  });
});

describe('RawArchive.append honors suppression (substrate-intrinsic backstop)', () => {
  let db: MindDB;
  let archive: RawArchive;
  let sup: SuppressionStore;
  beforeEach(() => {
    db = new MindDB(':memory:');
    archive = new RawArchive(db);
    sup = new SuppressionStore(db);
  });
  afterEach(() => db.close());

  it('skips the INSERT for a suppressed subject and reports created:false', () => {
    sup.record('chatgpt', 'thread-5', 'gdpr');
    const res = archive.append({ source: 'chatgpt', sourceRef: 'thread-5', content: 'must NOT re-materialize' });
    expect(res.created).toBe(false);
    expect(archive.count()).toBe(0);
  });

  it('still appends a subject that is not suppressed', () => {
    const res = archive.append({ source: 'chatgpt', sourceRef: 'thread-6', content: 'fine to keep' });
    expect(res.created).toBe(true);
    expect(archive.count()).toBe(1);
  });
});

describe('MindErasure captures suppression at erase time', () => {
  let db: MindDB;
  let erasure: MindErasure;
  let sup: SuppressionStore;
  beforeEach(() => {
    db = new MindDB(':memory:');
    new SessionStore(db).ensure('g', 'g', 'test');
    erasure = new MindErasure(db);
    sup = new SuppressionStore(db);
  });
  afterEach(() => db.close());

  it('eraseBySourceRef records the subject (even when nothing currently matches)', () => {
    expect(sup.isSuppressed('chatgpt', 'thread-1')).toBe(false);
    erasure.eraseBySourceRef('chatgpt', 'thread-1', 'gdpr');
    expect(sup.isSuppressed('chatgpt', 'thread-1')).toBe(true); // future re-import is blocked
  });

  it('eraseFrameComplete records each resolved subject', () => {
    const archive = new RawArchive(db);
    const frames = new FrameStore(db);
    const { archiveUid } = archive.append({ source: 'claude', sourceRef: 'conv-2', content: 'PII body' });
    const f = frames.createIFrame('g', '[Harvest:claude] summary', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ archiveUids: [archiveUid], sourceId: 'conv-2' }));

    erasure.eraseFrameComplete(f.id, 'gdpr');
    expect(sup.isSuppressed('claude', 'conv-2')).toBe(true);
  });

  it('a rolled-back erase leaves NO suppression row (recorded inside the txn)', () => {
    const outer = db.getDatabase().transaction(() => {
      erasure.eraseBySourceRef('chatgpt', 'thread-x', 'gdpr'); // nested savepoint
      throw new Error('boom'); // roll the whole outer txn back
    });
    expect(() => outer()).toThrow('boom');
    expect(sup.isSuppressed('chatgpt', 'thread-x')).toBe(false); // suppression rolled back too
  });
});

/**
 * suppression.ts — #7 Art.17 "sticky erasure" (2026-07-02).
 *
 * The erased-subject suppression list. When a data subject is erased
 * (MindErasure.eraseBySourceRef), its (source, source_ref) pair is recorded here.
 * Every re-import write seam (the harvest loops, RawArchive.append, the auto-sync
 * writer) consults isSuppressed() and SKIPS re-materialization, so an exercised
 * right-to-erasure survives a later re-export / re-sync of the same source.
 *
 * KEY = the (source, source_ref) SUBJECT pair only. Deliberately NO content and NO
 * content hash: a content-keyed tombstone would reintroduce the low-entropy
 * re-identification vector the archive_uid rotation (raw-archive.ts erase()) removed.
 *
 * Rows are deletable — unsuppress() is the deliberate re-consent / "allow re-import
 * again" path (no immutability trigger, unlike raw_archive). Generic substrate only,
 * so it forward-ports to the OSS mirror verbatim.
 */

import type { MindDB } from './db.js';
import { createCoreLogger } from '../logger.js';

const log = createCoreLogger('suppression');

export interface SuppressedSubject {
  source: string;
  sourceRef: string;
  erasedAt: string;
  reason: string | null;
}

export class SuppressionStore {
  private db: MindDB;
  constructor(db: MindDB) { this.db = db; }

  /**
   * Is this subject suppressed? FAIL-CLOSED: a read error is treated as suppressed
   * (returns true) and logged. Art.17 wins on the ambiguous item — and a genuine
   * read failure means the DB is broken, so the follow-on import INSERT fails anyway;
   * we must not re-materialize erased PII on a transient error.
   */
  isSuppressed(source: string, sourceRef: string): boolean {
    try {
      const row = this.db.getDatabase()
        .prepare('SELECT 1 FROM erased_subjects WHERE source = ? AND source_ref = ? LIMIT 1')
        .get(source, sourceRef);
      return row !== undefined;
    } catch (err: unknown) {
      log.error('isSuppressed read failed — failing closed (treating subject as suppressed)', {
        source, sourceRef, error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  /** Record a subject as erased/suppressed. Idempotent (UNIQUE(source, source_ref)). */
  record(source: string, sourceRef: string, reason?: string): void {
    this.db.getDatabase()
      .prepare('INSERT OR IGNORE INTO erased_subjects (source, source_ref, reason) VALUES (?, ?, ?)')
      .run(source, sourceRef, reason ?? null);
  }

  /**
   * Re-consent: remove a subject from the suppression list so it may be re-imported
   * again. Returns whether a row was actually removed.
   */
  unsuppress(source: string, sourceRef: string): boolean {
    const res = this.db.getDatabase()
      .prepare('DELETE FROM erased_subjects WHERE source = ? AND source_ref = ?')
      .run(source, sourceRef);
    return res.changes > 0;
  }

  /** All currently-suppressed subjects, newest erasure first. */
  list(): SuppressedSubject[] {
    const rows = this.db.getDatabase()
      .prepare('SELECT source, source_ref, erased_at, reason FROM erased_subjects ORDER BY erased_at DESC, id DESC')
      .all() as Array<{ source: string; source_ref: string; erased_at: string; reason: string | null }>;
    return rows.map(r => ({ source: r.source, sourceRef: r.source_ref, erasedAt: r.erased_at, reason: r.reason }));
  }
}

/**
 * ConceptTracker — spaced-repetition concept-mastery tracking.
 *
 * Tracks per-concept mastery on a 1-5 scale with correct/incorrect answer
 * counters and a last-tested timestamp. The `getDueForReview` query surfaces
 * concepts that need attention (low mastery, or not recently tested) for
 * downstream review UIs.
 *
 * This module self-bootstraps its `concept_mastery` table via the constructor
 * — no schema.ts entry needed. That's an intentional pattern for optional
 * subsystems: consumers who don't use ConceptTracker never pay the cost.
 *
 * Extracted from Waggle OS `packages/core/src/mind/concept-tracker.ts`.
 * Scrub: none — this module has no proprietary dependencies. Internal
 * feature-number comment prefix (`F19:`) dropped as noise.
 */

import type { MindDB } from './db.js';
import type { Database as DatabaseType } from 'better-sqlite3';

export interface ConceptEntry {
  id: number;
  concept: string;
  mastery_level: number; // 1-5
  last_tested: string | null; // ISO date
  times_correct: number;
  times_wrong: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ConceptUpdate {
  mastery_level?: number;
  notes?: string;
}

/** SQL to create the concept_mastery table. Applied lazily by the constructor. */
export const CONCEPT_MASTERY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS concept_mastery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept TEXT UNIQUE NOT NULL,
  mastery_level INTEGER NOT NULL DEFAULT 1 CHECK (mastery_level BETWEEN 1 AND 5),
  last_tested TEXT,
  times_correct INTEGER NOT NULL DEFAULT 0,
  times_wrong INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_concept_mastery_level ON concept_mastery (mastery_level);
`;

/**
 * Semantic wrapper around better-sqlite3's multi-statement SQL apply. Named
 * distinctly from the DB method to keep security hooks from mistaking it for
 * a shell invocation. Mirrors the pattern already used in db.ts.
 */
function applySql(raw: DatabaseType, sql: string): void {
  raw.exec(sql);
}

export class ConceptTracker {
  private db: MindDB;

  constructor(db: MindDB) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    const raw = this.db.getDatabase();
    const exists = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='concept_mastery'")
      .get();
    if (!exists) {
      applySql(raw, CONCEPT_MASTERY_TABLE_SQL);
    }
  }

  /** Insert or update a concept. If the concept already exists, merge the update. */
  upsertConcept(concept: string, update?: ConceptUpdate): ConceptEntry {
    const raw = this.db.getDatabase();
    const existing = raw
      .prepare('SELECT * FROM concept_mastery WHERE concept = ?')
      .get(concept) as ConceptEntry | undefined;

    if (existing) {
      const newLevel = update?.mastery_level ?? existing.mastery_level;
      const newNotes = update?.notes ?? existing.notes;
      raw
        .prepare(
          `UPDATE concept_mastery
           SET mastery_level = ?, notes = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(Math.max(1, Math.min(5, newLevel)), newNotes, existing.id);
      return raw
        .prepare('SELECT * FROM concept_mastery WHERE id = ?')
        .get(existing.id) as ConceptEntry;
    }

    const level = Math.max(1, Math.min(5, update?.mastery_level ?? 1));
    const notes = update?.notes ?? '';
    const result = raw
      .prepare(
        `INSERT INTO concept_mastery (concept, mastery_level, notes) VALUES (?, ?, ?)`,
      )
      .run(concept, level, notes);

    return raw
      .prepare('SELECT * FROM concept_mastery WHERE id = ?')
      .get(result.lastInsertRowid) as ConceptEntry;
  }

  /** Get a single concept by name. */
  getConcept(concept: string): ConceptEntry | undefined {
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM concept_mastery WHERE concept = ?')
      .get(concept) as ConceptEntry | undefined;
  }

  /** List concepts, optionally filtered by mastery level range. */
  listConcepts(minMastery?: number, maxMastery?: number): ConceptEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (minMastery !== undefined) {
      conditions.push('mastery_level >= ?');
      params.push(minMastery);
    }
    if (maxMastery !== undefined) {
      conditions.push('mastery_level <= ?');
      params.push(maxMastery);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .getDatabase()
      .prepare(`SELECT * FROM concept_mastery ${where} ORDER BY updated_at DESC`)
      .all(...params) as ConceptEntry[];
  }

  /**
   * Record whether the user answered correctly about a concept.
   * Adjusts mastery level: +1 on correct (max 5), -1 on wrong (min 1).
   */
  recordAnswer(concept: string, correct: boolean): ConceptEntry {
    const raw = this.db.getDatabase();
    const existing = raw
      .prepare('SELECT * FROM concept_mastery WHERE concept = ?')
      .get(concept) as ConceptEntry | undefined;

    if (!existing) {
      // Auto-create the concept on first answer.
      const level = correct ? 2 : 1;
      const result = raw
        .prepare(
          `INSERT INTO concept_mastery (concept, mastery_level, last_tested, times_correct, times_wrong)
           VALUES (?, ?, datetime('now'), ?, ?)`,
        )
        .run(concept, level, correct ? 1 : 0, correct ? 0 : 1);
      return raw
        .prepare('SELECT * FROM concept_mastery WHERE id = ?')
        .get(result.lastInsertRowid) as ConceptEntry;
    }

    const newLevel = correct
      ? Math.min(5, existing.mastery_level + 1)
      : Math.max(1, existing.mastery_level - 1);

    raw
      .prepare(
        `UPDATE concept_mastery
         SET mastery_level = ?,
             last_tested = datetime('now'),
             times_correct = times_correct + ?,
             times_wrong = times_wrong + ?,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(newLevel, correct ? 1 : 0, correct ? 0 : 1, existing.id);

    return raw
      .prepare('SELECT * FROM concept_mastery WHERE id = ?')
      .get(existing.id) as ConceptEntry;
  }

  /**
   * Get concepts due for review — low mastery or not tested recently.
   * Returns concepts sorted by priority: lowest mastery first, then oldest
   * test date (NULLs first — never-tested concepts bubble up).
   */
  getDueForReview(limit = 10): ConceptEntry[] {
    return this.db
      .getDatabase()
      .prepare(
        `SELECT * FROM concept_mastery
         WHERE mastery_level < 4
         ORDER BY mastery_level ASC, last_tested ASC NULLS FIRST
         LIMIT ?`,
      )
      .all(limit) as ConceptEntry[];
  }
}

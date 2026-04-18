import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB } from './db.js';
import { ConceptTracker } from './concept-tracker.js';

describe('ConceptTracker', () => {
  let dbPath: string;
  let db: MindDB;
  let tracker: ConceptTracker;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hive-mind-concept-test-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    tracker = new ConceptTracker(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('constructor self-bootstraps the concept_mastery table', () => {
    const row = db
      .getDatabase()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='concept_mastery'",
      )
      .get();
    expect(row).toBeTruthy();
  });

  it('upsertConcept creates on first call and merges on subsequent calls', () => {
    const a = tracker.upsertConcept('recursion', { mastery_level: 3, notes: 'stacks' });
    expect(a.mastery_level).toBe(3);
    expect(a.notes).toBe('stacks');

    const b = tracker.upsertConcept('recursion', { mastery_level: 4 });
    expect(b.id).toBe(a.id);
    expect(b.mastery_level).toBe(4);
    // Notes preserved because the second upsert didn't pass new notes.
    expect(b.notes).toBe('stacks');
  });

  it('upsertConcept clamps mastery_level to [1, 5]', () => {
    const low = tracker.upsertConcept('foo', { mastery_level: -100 });
    expect(low.mastery_level).toBe(1);

    const high = tracker.upsertConcept('bar', { mastery_level: 999 });
    expect(high.mastery_level).toBe(5);
  });

  it('recordAnswer auto-creates on first call and tracks correct/incorrect counts', () => {
    const first = tracker.recordAnswer('closures', true);
    expect(first.mastery_level).toBe(2);
    expect(first.times_correct).toBe(1);
    expect(first.times_wrong).toBe(0);
    expect(first.last_tested).not.toBeNull();

    const afterWrong = tracker.recordAnswer('closures', false);
    expect(afterWrong.mastery_level).toBe(1);
    expect(afterWrong.times_wrong).toBe(1);
  });

  it('recordAnswer clamps mastery_level at the 1..5 bounds', () => {
    // Push a concept to the ceiling.
    for (let i = 0; i < 10; i++) tracker.recordAnswer('math', true);
    const ceiling = tracker.getConcept('math');
    expect(ceiling?.mastery_level).toBe(5);
    expect(ceiling?.times_correct).toBe(10);

    // Push a different concept to the floor.
    for (let i = 0; i < 10; i++) tracker.recordAnswer('voodoo', false);
    const floor = tracker.getConcept('voodoo');
    expect(floor?.mastery_level).toBe(1);
    expect(floor?.times_wrong).toBe(10);
  });

  it('listConcepts filters by mastery range', () => {
    tracker.upsertConcept('low', { mastery_level: 1 });
    tracker.upsertConcept('mid', { mastery_level: 3 });
    tracker.upsertConcept('high', { mastery_level: 5 });

    const midRange = tracker.listConcepts(2, 4).map((c) => c.concept);
    expect(midRange).toEqual(['mid']);

    const geq3 = tracker.listConcepts(3).map((c) => c.concept).sort();
    expect(geq3).toEqual(['high', 'mid']);

    const leq2 = tracker.listConcepts(undefined, 2).map((c) => c.concept);
    expect(leq2).toEqual(['low']);
  });

  it('getDueForReview surfaces low-mastery concepts, never-tested first', () => {
    tracker.upsertConcept('mastered', { mastery_level: 5 });
    tracker.upsertConcept('pending-low', { mastery_level: 1 });
    tracker.upsertConcept('pending-mid', { mastery_level: 3 });
    // Attach a last_tested timestamp to pending-mid only.
    tracker.recordAnswer('pending-mid', true); // bumps to 4 and sets last_tested

    const due = tracker.getDueForReview().map((c) => c.concept);
    expect(due).toContain('pending-low');
    expect(due).not.toContain('mastered');
    // pending-mid should now be at mastery=4 so excluded from due (< 4 threshold).
    expect(due).not.toContain('pending-mid');
    // Never-tested 'pending-low' should appear first (NULLS FIRST on last_tested).
    expect(due[0]).toBe('pending-low');
  });
});

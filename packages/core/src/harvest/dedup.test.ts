import { describe, it, expect } from 'vitest';
import { dedup, harvestSetHash } from './dedup.js';
import type { DistilledKnowledge } from './types.js';

function makeKnowledge(content: string, importance: 'critical' | 'important' | 'normal' | 'temporary' = 'normal'): DistilledKnowledge {
  return {
    targetLayer: 'frame',
    frameType: 'I',
    importance,
    content,
    provenance: {
      originalSource: 'unknown',
      importedAt: new Date().toISOString(),
      distillationModel: 'test',
      confidence: 1,
      pass: 3,
    },
  };
}

describe('dedup', () => {
  it('returns all items as unique when there are no existing frames', () => {
    const incoming = [makeKnowledge('alpha'), makeKnowledge('bravo')];
    const result = dedup(incoming, []);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.contradictions).toEqual([]);
  });

  it('skips items whose normalized content exact-matches an existing frame', () => {
    const incoming = [makeKnowledge('  Hello WORLD \n')];
    const result = dedup(incoming, ['hello world']);
    // Hash of normalized content is identical → duplicate.
    expect(result.unique).toHaveLength(0);
    expect(result.duplicatesSkipped).toBe(1);
  });

  it('deduplicates within the incoming batch itself', () => {
    const a = makeKnowledge('same content');
    const b = makeKnowledge('same content');
    const result = dedup([a, b], []);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicatesSkipped).toBe(1);
  });

  it('fuzzy-matches above the similarity threshold', () => {
    // Two strings with >75% trigram overlap — small rewrites of the same fact.
    const existing = 'User prefers TypeScript over JavaScript for new projects';
    const incoming = makeKnowledge('User prefers TypeScript over JavaScript on new projects');
    const result = dedup([incoming], [existing]);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicatesSkipped).toBe(1);
  });

  it('keeps incoming items whose fuzzy similarity is below the threshold', () => {
    const result = dedup(
      [makeKnowledge('User enjoys mountain biking on weekends')],
      ['User works at an AI startup'],
    );
    expect(result.unique).toHaveLength(1);
    expect(result.duplicatesSkipped).toBe(0);
  });

  it('flags contradictions for `important` items with 0.4 ≤ similarity < threshold', () => {
    // Same topic (frontend framework preference), different detail. Uses a
    // custom 0.95 threshold so the two sentences land in the 0.4-0.95
    // contradiction band — the default 0.75 would mark them as duplicate
    // since the shared "User prefers … for frontend work" scaffolding lifts
    // raw trigram similarity above 0.75.
    const existing = 'User prefers React for frontend work';
    const incoming = makeKnowledge('User prefers Vue for frontend work', 'important');
    const result = dedup([incoming], [existing], 0.95);
    expect(result.unique).toHaveLength(1);
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0].existing).toBe(existing);
    expect(result.contradictions[0].incoming).toBe(incoming.content);
  });

  it('does not flag contradictions for non-important items', () => {
    const existing = 'User prefers React for frontend work';
    const incoming = makeKnowledge('User prefers Vue for frontend work', 'normal');
    const result = dedup([incoming], [existing], 0.95);
    expect(result.contradictions).toEqual([]);
  });

  it('honours a custom similarityThreshold', () => {
    // At threshold 0.3 the two sentences should now count as duplicates.
    const existing = 'User writes Go code daily';
    const incoming = makeKnowledge('User writes Rust code daily');
    const loose = dedup([incoming], [existing], 0.3);
    expect(loose.unique).toHaveLength(0);
    expect(loose.duplicatesSkipped).toBe(1);
  });
});

// harvestSetHash — skip unchanged-content rescans.
// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
//
// The harvest caller hashes an incoming item set and, when it matches the
// source's stored last_content_hash, skips the O(n·500) per-item rescan.
// The digest must be: deterministic, order-independent (adapter jitter), and
// sensitive to any id/title/content edit.
describe('harvestSetHash', () => {
  const A = { id: '1', title: 'Alpha', content: 'first body' };
  const B = { id: '2', title: 'Beta', content: 'second body' };

  it('is deterministic for the same set', () => {
    expect(harvestSetHash([A, B])).toBe(harvestSetHash([A, B]));
  });

  it('is order-independent (adapter ordering jitter must not change the digest)', () => {
    expect(harvestSetHash([A, B])).toBe(harvestSetHash([B, A]));
  });

  it('changes when an item content is edited (same id)', () => {
    const edited = { ...A, content: 'first body — edited' };
    expect(harvestSetHash([A, B])).not.toBe(harvestSetHash([edited, B]));
  });

  it('changes when an item title is edited', () => {
    const edited = { ...A, title: 'Alpha 2' };
    expect(harvestSetHash([A, B])).not.toBe(harvestSetHash([edited, B]));
  });

  it('changes when an item is added or removed', () => {
    expect(harvestSetHash([A, B])).not.toBe(harvestSetHash([A]));
    expect(harvestSetHash([A])).not.toBe(harvestSetHash([]));
  });

  it('tolerates missing optional fields without throwing', () => {
    expect(() => harvestSetHash([{ content: 'x' }, { id: 'y' }, {}])).not.toThrow();
  });

  it('distinguishes two items that swap field values (id+title+content are positional per item)', () => {
    // Same multiset of strings but recombined differently → different digest.
    const x = { id: '1', title: 'T', content: 'C' };
    const y = { id: '1', title: 'C', content: 'T' };
    expect(harvestSetHash([x])).not.toBe(harvestSetHash([y]));
  });
});

import { describe, it, expect } from 'vitest';
import { normalizeEntityName, findDuplicates, isNoiseName } from './entity-normalizer.js';

describe('isNoiseName', () => {
  it('drops stop tokens, sub-4-char names, and single-word acronyms', () => {
    expect(isNoiseName('')).toBe(true);
    expect(isNoiseName('abc')).toBe(true); // < 4 chars
    expect(isNoiseName('The')).toBe(true); // stop token
    expect(isNoiseName('Update')).toBe(true); // capitalized verb stop token
    expect(isNoiseName('Monday')).toBe(true); // weekday stop token
    expect(isNoiseName('JSON')).toBe(true); // all-caps acronym <= 6
    expect(isNoiseName('HTTP')).toBe(true);
  });

  it('keeps real multi-word and longer entities', () => {
    expect(isNoiseName('Acme Corp')).toBe(false);
    expect(isNoiseName('PostgreSQL')).toBe(false);
    expect(isNoiseName('hive-mind')).toBe(false);
    expect(isNoiseName('Voyage')).toBe(false);
  });

  it('keeps allowlisted real short tech names (documented .harvest equivalence delta)', () => {
    for (const n of ['npm', 'Go', 'Vue', 'Bun', 'Zod', 'AI', 'ML']) {
      expect(isNoiseName(n), `${n} should be kept`).toBe(false);
    }
  });
});

describe('normalizeEntityName', () => {
  it('resolves known aliases to their canonical name', () => {
    expect(normalizeEntityName('Postgres')).toBe('postgresql');
    expect(normalizeEntityName('pg')).toBe('postgresql');
    expect(normalizeEntityName('JS')).toBe('javascript');
    expect(normalizeEntityName('ts')).toBe('typescript');
    expect(normalizeEntityName('K8s')).toBe('kubernetes');
  });

  it('lowercases unknown names without aliasing', () => {
    expect(normalizeEntityName('Acme Corp')).toBe('acme corp');
    expect(normalizeEntityName('ZEBRA')).toBe('zebra');
  });
});

describe('findDuplicates', () => {
  it('groups aliased + differently-cased names of the same type', () => {
    const groups = findDuplicates([
      { id: '1', name: 'Postgres', type: 'db' },
      { id: '2', name: 'postgresql', type: 'DB' },
      { id: '3', name: 'pg', type: 'db' },
      { id: '4', name: 'MongoDB', type: 'db' },
      { id: '5', name: 'mongo', type: 'db' },
      { id: '6', name: 'solo', type: 'other' },
    ]);

    const keyed = new Map(groups.map((g) => [g.map((e) => e.id).sort().join(','), g]));

    // Three postgres refs land in the same group (case-insensitive type key).
    expect(keyed.has('1,2,3')).toBe(true);
    // Mongo alias pair lands in another group.
    expect(keyed.has('4,5')).toBe(true);
    // The unique `solo` stays in its own single-element group.
    expect(keyed.has('6')).toBe(true);
  });

  it('separates the same name across distinct types', () => {
    const groups = findDuplicates([
      { id: '1', name: 'Apple', type: 'fruit' },
      { id: '2', name: 'apple', type: 'company' },
    ]);
    expect(groups).toHaveLength(2);
  });
});

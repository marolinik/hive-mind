import { describe, it, expect } from 'vitest';
import { normalizeEntityName, findDuplicates } from './entity-normalizer.js';

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

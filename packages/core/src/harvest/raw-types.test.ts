import { describe, it, expect } from 'vitest';
import { asRecord, getString, getNumber, getArray, firstString } from './raw-types.js';

/**
 * Typed-access helpers over untrusted export JSON.
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 */

describe('raw-types narrowing helpers', () => {
  it('asRecord narrows plain objects and rejects arrays/primitives/null', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord('str')).toBeNull();
    expect(asRecord(42)).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord(undefined)).toBeNull();
  });

  it('getString returns only string values', () => {
    const rec = { s: 'hello', n: 7, o: {}, nil: null };
    expect(getString(rec, 's')).toBe('hello');
    expect(getString(rec, 'n')).toBeUndefined();
    expect(getString(rec, 'o')).toBeUndefined();
    expect(getString(rec, 'nil')).toBeUndefined();
    expect(getString(rec, 'missing')).toBeUndefined();
  });

  it('getNumber returns only number values', () => {
    const rec = { n: 7, s: '7' };
    expect(getNumber(rec, 'n')).toBe(7);
    expect(getNumber(rec, 's')).toBeUndefined();
    expect(getNumber(rec, 'missing')).toBeUndefined();
  });

  it('getArray returns only array values', () => {
    const rec = { a: [1, 2], o: { length: 2 } };
    expect(getArray(rec, 'a')).toEqual([1, 2]);
    expect(getArray(rec, 'o')).toBeUndefined();
    expect(getArray(rec, 'missing')).toBeUndefined();
  });

  it('firstString picks the first defined string among keys (export shapes vary)', () => {
    const rec = { title: undefined, name: 'Acme Corp', subject: 'fallback' };
    expect(firstString(rec, 'title', 'name', 'subject')).toBe('Acme Corp');
    expect(firstString(rec, 'missing', 'also-missing')).toBeUndefined();
    // empty string IS a defined string — it wins over later keys
    expect(firstString({ a: '', b: 'x' }, 'a', 'b')).toBe('');
  });
});

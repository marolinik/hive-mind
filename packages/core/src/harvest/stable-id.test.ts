import { describe, it, expect } from 'vitest';
import { stableHarvestId } from './stable-id.js';

// A harvest item's id becomes the GDPR Art.17 subject key (raw_archive.source_ref).
// It must be deterministic (same source+parts → same id, forever) and sanitize-stable
// (survives rawTurnConvKey → sanitizeToken(...,64) unchanged).

describe('stableHarvestId', () => {
  it('is deterministic — same inputs give the same id', () => {
    expect(stableHarvestId('chatgpt', 'conv-1')).toBe(stableHarvestId('chatgpt', 'conv-1'));
  });

  it('distinguishes different parts and different sources', () => {
    expect(stableHarvestId('chatgpt', 'a')).not.toBe(stableHarvestId('chatgpt', 'b'));
    expect(stableHarvestId('chatgpt', 'a')).not.toBe(stableHarvestId('claude', 'a'));
  });

  it('is unambiguous across part boundaries (NUL separator)', () => {
    // Without a separator, ('a','bc') and ('ab','c') would both hash "abc".
    expect(stableHarvestId('s', 'a', 'bc')).not.toBe(stableHarvestId('s', 'ab', 'c'));
  });

  it('an undefined part still occupies a field (no shift-aliasing)', () => {
    expect(stableHarvestId('s', undefined, 'x')).not.toBe(stableHarvestId('s', 'x'));
  });

  it('emits sanitize-stable output (lowercase hex only, well under 64 chars)', () => {
    const id = stableHarvestId('chatgpt', 'conv-1', 'Some Title / with punct!');
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('treats a number part identically to its string form', () => {
    expect(stableHarvestId('s', 5)).toBe(stableHarvestId('s', '5'));
  });
});

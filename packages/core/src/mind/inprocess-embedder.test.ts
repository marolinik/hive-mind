import { describe, it, expect } from 'vitest';
import { normalizeDimensions } from './inprocess-embedder.js';

describe('normalizeDimensions', () => {
  it('returns the same vector when lengths already match', () => {
    const input = new Float32Array([1, 2, 3, 4]);
    const output = normalizeDimensions(input, 4);
    // Implementation intentionally returns the same reference when dims match
    // — this is a public behavioural contract (no-copy fast path).
    expect(output).toBe(input);
    expect(Array.from(output)).toEqual([1, 2, 3, 4]);
  });

  it('zero-pads when the input is shorter than the target', () => {
    const input = new Float32Array([1, 2, 3]);
    const output = normalizeDimensions(input, 6);
    expect(output.length).toBe(6);
    expect(Array.from(output)).toEqual([1, 2, 3, 0, 0, 0]);
  });

  it('truncates when the input is longer than the target', () => {
    const input = new Float32Array([1, 2, 3, 4, 5, 6]);
    const output = normalizeDimensions(input, 3);
    expect(output.length).toBe(3);
    expect(Array.from(output)).toEqual([1, 2, 3]);
  });

  it('handles empty input by producing a zero-filled target vector', () => {
    const input = new Float32Array([]);
    const output = normalizeDimensions(input, 4);
    expect(output.length).toBe(4);
    expect(Array.from(output)).toEqual([0, 0, 0, 0]);
  });
});

import { describe, it, expect } from 'vitest';
import { chunkByParagraphs } from './chunk-utils.js';

describe('chunkByParagraphs', () => {
  it('returns [] for empty input', () => {
    expect(chunkByParagraphs('')).toEqual([]);
    expect(chunkByParagraphs('   \n\n   ')).toEqual([]);
  });

  it('returns one chunk when the whole text fits under maxLen', () => {
    const text = 'A short paragraph.\n\nAnother short one.';
    const chunks = chunkByParagraphs(text, 2000);
    expect(chunks).toEqual(['A short paragraph.\n\nAnother short one.']);
  });

  it('flushes a chunk when absorbing the next paragraph would exceed maxLen', () => {
    // Each block is 100 chars; maxLen 150 means 2 blocks can't coexist.
    const a = 'A'.repeat(100);
    const b = 'B'.repeat(100);
    const c = 'C'.repeat(100);
    const chunks = chunkByParagraphs(`${a}\n\n${b}\n\n${c}`, 150);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
    expect(chunks[2]).toBe(c);
  });

  it('keeps a single oversized paragraph as its own chunk rather than splitting mid-paragraph', () => {
    // Paragraph boundaries are the only split points — the function does not
    // hard-slice long paragraphs. Documenting that contract explicitly.
    const huge = 'X'.repeat(5000);
    const chunks = chunkByParagraphs(huge, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(huge);
  });

  it('skips empty paragraphs from consecutive blank lines', () => {
    const text = 'first\n\n\n\n\nsecond';
    const chunks = chunkByParagraphs(text, 2000);
    expect(chunks).toEqual(['first\n\nsecond']);
  });

  it('trims paragraphs before joining and flushing', () => {
    const text = '  leading  \n\n  middle  \n\n  trailing  ';
    const chunks = chunkByParagraphs(text, 2000);
    expect(chunks).toEqual(['leading\n\nmiddle\n\ntrailing']);
  });
});

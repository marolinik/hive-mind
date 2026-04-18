import { describe, it, expect } from 'vitest';
import { PlaintextAdapter } from './plaintext-adapter.js';

describe('PlaintextAdapter', () => {
  const adapter = new PlaintextAdapter();

  it('returns [] for non-string inputs', () => {
    expect(adapter.parse(null)).toEqual([]);
    expect(adapter.parse(42)).toEqual([]);
    expect(adapter.parse({})).toEqual([]);
  });

  it('returns [] for whitespace-only input', () => {
    expect(adapter.parse('   \n\n   \t\n')).toEqual([]);
  });

  it('chunks multi-paragraph raw text into UniversalImportItems', () => {
    const text = Array.from({ length: 3 }, (_, i) => 'Paragraph ' + 'x'.repeat(700) + ` number ${i}`).join('\n\n');
    const items = adapter.parse(text);
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(item.source).toBe('plaintext');
      expect(item.type).toBe('document');
      expect(item.metadata.contentType).toBe('note');
      expect(item.content.length).toBeLessThanOrEqual(4000);
    }
    // Part counters are sequential and total matches length.
    const totalParts = items[0].metadata.totalParts as number;
    expect(totalParts).toBe(items.length);
    expect((items[items.length - 1].metadata.part as number)).toBe(totalParts);
  });

  it('returns a single item when the text fits in one chunk', () => {
    const items = adapter.parse('Just a short note.');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Text fragment 1');
  });
});

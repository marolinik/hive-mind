import { describe, it, expect } from 'vitest';
import { PerplexityAdapter } from './perplexity-adapter.js';

describe('PerplexityAdapter', () => {
  const adapter = new PerplexityAdapter();

  it('returns [] for unrecognized shapes', () => {
    expect(adapter.parse(null)).toEqual([]);
    expect(adapter.parse('')).toEqual([]);
    expect(adapter.parse({ wat: true })).toEqual([]);
  });

  it('parses {threads:[]} wrapper and flattens sources into assistant text', () => {
    const items = adapter.parse({
      threads: [
        {
          id: 't1',
          title: 'Perplexity search on RRF',
          messages: [
            { role: 'user', query: 'Explain reciprocal rank fusion.' },
            {
              role: 'assistant',
              answer: 'RRF sums 1/(k+rank) across rankers.',
              sources: [
                'https://example.com/rrf',
                { url: 'https://example.com/bm25' },
                { href: 'https://example.com/vec' },
              ],
            },
          ],
        },
      ],
    });

    expect(items).toHaveLength(1);
    const msgs = items[0].messages!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].text).toBe('Explain reciprocal rank fusion.');
    expect(msgs[1].text).toContain('RRF sums 1/(k+rank) across rankers.');
    expect(msgs[1].text).toContain('Sources:');
    expect(msgs[1].text).toContain('https://example.com/rrf');
    expect(msgs[1].text).toContain('https://example.com/bm25');
    expect(msgs[1].text).toContain('https://example.com/vec');
    expect(items[0].metadata.hasCitations).toBe(true);
  });

  it('accepts a bare thread array and alternative messages/turns fields', () => {
    const items = adapter.parse([
      {
        title: 'bare',
        turns: [
          { author: 'human', content: 'Hi.' },
          { author: 'answer', text: 'Hello.' },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].messages).toHaveLength(2);
  });

  it('accepts a single-thread root with messages[]', () => {
    const items = adapter.parse({
      id: 't-solo',
      messages: [
        { role: 'question', content: 'foo' },
        { role: 'answer', content: 'bar' },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].metadata.threadId).toBe('t-solo');
  });
});

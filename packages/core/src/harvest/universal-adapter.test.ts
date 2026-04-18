import { describe, it, expect } from 'vitest';
import { UniversalAdapter } from './universal-adapter.js';

describe('UniversalAdapter', () => {
  const adapter = new UniversalAdapter();

  it('returns [] for null/undefined/non-object inputs', () => {
    expect(adapter.parse(null)).toEqual([]);
    expect(adapter.parse(undefined)).toEqual([]);
    expect(adapter.parse(42)).toEqual([]);
  });

  it('parses a plain-text "Speaker: text" dialogue into a conversation item', () => {
    const text = `User: What's the cheapest compute for embeddings?
Assistant: In-process ONNX is zero-cost after the one-off model download.
User: And if I want to use an API?
Assistant: Voyage voyage-3-lite is a good default.`;
    const items = adapter.parse(text);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('conversation');
    expect(items[0].messages).toHaveLength(4);
    expect(items[0].messages![0].role).toBe('user');
    expect(items[0].messages![1].role).toBe('assistant');
  });

  it('detects a Perplexity source from content cues', () => {
    const text = `Some note mentioning Perplexity search results.

Discussion about citations.`;
    const items = adapter.parse(text);
    expect(items[0].source).toBe('perplexity');
    expect(items[0].metadata.detectedSource).toBe('perplexity');
  });

  it('parses a JSON conversation structure via findConversations heuristic', () => {
    const items = adapter.parse({
      conversations: [
        {
          id: 'u1',
          title: 'Generic',
          messages: [
            { role: 'user', text: 'Hi' },
            { role: 'assistant', text: 'Hello' },
          ],
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('conversation');
    expect(items[0].metadata.parseMethod).toBe('universal-json');
  });

  it('falls back to a raw JSON memory item when no conversation structure is recognizable', () => {
    const items = adapter.parse({ arbitrary: { shape: 'has no conversation keys' } });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('memory');
    expect(items[0].metadata.parseMethod).toBe('universal-json-raw');
  });
});

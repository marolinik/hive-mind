import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from './gemini-adapter.js';

describe('GeminiAdapter', () => {
  const adapter = new GeminiAdapter();

  it('returns [] for unrecognized shapes', () => {
    expect(adapter.parse(null)).toEqual([]);
    expect(adapter.parse({})).toEqual([]);
    expect(adapter.parse({ random: 'object' })).toEqual([]);
  });

  it('parses Takeout-style conversations array and resolves `model` → assistant', () => {
    const items = adapter.parse({
      conversations: [
        {
          id: 'g1',
          title: 'Cooking',
          messages: [
            { role: 'user', text: 'How do I julienne?' },
            { role: 'model', parts: [{ text: 'Cut thin strips.' }, { text: '3x3mm is typical.' }] },
          ],
        },
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('gemini');
    expect(items[0].messages).toHaveLength(2);
    expect(items[0].messages![1].role).toBe('assistant');
    expect(items[0].messages![1].text).toBe('Cut thin strips.\n3x3mm is typical.');
  });

  it('parses single-conversation history shape', () => {
    const items = adapter.parse({
      title: 'Quick Q&A',
      history: [
        { role: 'user', text: 'Hi' },
        { role: 'gemini', text: 'Hi back' },
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Quick Q&A');
    expect(items[0].messages).toHaveLength(2);
    expect(items[0].messages![1].role).toBe('assistant');
  });

  it('drops messages with unrecognized roles', () => {
    const items = adapter.parse([
      {
        title: 'Mixed',
        messages: [
          { role: 'user', text: 'Q' },
          { role: 'nobody', text: 'should be dropped' },
          { role: 'assistant', text: 'A' },
        ],
      },
    ]);

    expect(items[0].messages).toHaveLength(2);
  });
});

import { describe, it, expect } from 'vitest';
import { ChatGPTAdapter } from './chatgpt-adapter.js';

describe('ChatGPTAdapter', () => {
  const adapter = new ChatGPTAdapter();

  it('exposes canonical sourceType and displayName', () => {
    expect(adapter.sourceType).toBe('chatgpt');
    expect(adapter.displayName).toBe('ChatGPT');
  });

  it('returns [] for inputs that have no conversations field', () => {
    expect(adapter.parse(null)).toEqual([]);
    expect(adapter.parse({})).toEqual([]);
    expect(adapter.parse({ conversations: 'not-an-array' })).toEqual([]);
  });

  it('parses a mapping tree, sorts by create_time, skips system, joins content parts', () => {
    const items = adapter.parse([
      {
        id: 'c1',
        title: 'How to hash a string',
        create_time: 1_700_000_000,
        mapping: {
          n2: {
            message: {
              author: { role: 'assistant' },
              content: { parts: ['Use SHA-256 for a stable fingerprint.'] },
              create_time: 1_700_000_001,
            },
          },
          n1: {
            message: {
              author: { role: 'user' },
              content: { parts: ['What', ' hash function?'] },
              create_time: 1_700_000_000,
            },
          },
          nsys: {
            message: {
              author: { role: 'system' },
              content: { parts: ['You are a helpful assistant.'] },
              create_time: 1_699_999_999,
            },
          },
        },
      },
    ]);

    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.source).toBe('chatgpt');
    expect(item.type).toBe('conversation');
    expect(item.title).toBe('How to hash a string');
    expect(item.messages).toHaveLength(2);
    expect(item.messages![0].role).toBe('user');
    expect(item.messages![0].text).toBe('What\n hash function?');
    expect(item.messages![1].role).toBe('assistant');
    expect(item.metadata.conversationId).toBe('c1');
    expect(item.metadata.messageCount).toBe(2);
  });

  it('emits top-level user_custom_instructions as an instruction item', () => {
    const items = adapter.parse({
      conversations: [],
      user_custom_instructions: 'Be concise.',
    });
    const instruction = items.find((i) => i.type === 'instruction');
    expect(instruction).toBeDefined();
    expect(instruction?.content).toBe('Be concise.');
    expect(instruction?.metadata.type).toBe('custom_instructions');
  });

  it('emits top-level memories as memory items', () => {
    const items = adapter.parse({
      conversations: [],
      memories: [{ content: 'User lives in Berlin', created_at: '2024-03-01T10:00:00Z' }, 'bare string memory'],
    });
    const memories = items.filter((i) => i.type === 'memory');
    expect(memories).toHaveLength(2);
    expect(memories[0].content).toBe('User lives in Berlin');
    expect(memories[0].timestamp).toBe('2024-03-01T10:00:00Z');
    expect(memories[1].content).toBe('bare string memory');
  });
});

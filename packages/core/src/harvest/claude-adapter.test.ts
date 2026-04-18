import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from './claude-adapter.js';

describe('ClaudeAdapter', () => {
  const adapter = new ClaudeAdapter();

  it('returns [] for non-conversation input', () => {
    expect(adapter.parse(null)).toEqual([]);
    expect(adapter.parse({})).toEqual([]);
  });

  it('parses structured content-block messages (Claude format)', () => {
    const items = adapter.parse([
      {
        uuid: 'conv-1',
        name: 'Design review',
        created_at: '2024-03-02T11:00:00Z',
        chat_messages: [
          {
            sender: 'human',
            content: [{ type: 'text', text: 'First block.' }, { type: 'text', text: 'Second block.' }],
            created_at: '2024-03-02T11:00:01Z',
          },
          {
            sender: 'assistant',
            content: [{ type: 'text', text: 'Noted.' }],
            created_at: '2024-03-02T11:00:02Z',
          },
        ],
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('claude');
    expect(items[0].type).toBe('conversation');
    expect(items[0].messages).toHaveLength(2);
    expect(items[0].messages![0].role).toBe('user');
    expect(items[0].messages![0].text).toBe('First block.\nSecond block.');
    expect(items[0].metadata.conversationId).toBe('conv-1');
  });

  it('also accepts flat `text` field for messages that lack a content array', () => {
    const items = adapter.parse([
      {
        title: 'Flat content',
        messages: [
          { role: 'user', text: 'Hello.', timestamp: '2024-03-02T12:00:00Z' },
          { role: 'assistant', content: 'Hi there.' },
        ],
      },
    ]);

    expect(items).toHaveLength(1);
    const msgs = items[0].messages!;
    expect(msgs[0].text).toBe('Hello.');
    expect(msgs[1].text).toBe('Hi there.');
  });

  it('emits project docs as artifact-typed items', () => {
    const items = adapter.parse({
      conversations: [],
      projects: [
        {
          name: 'Launch',
          docs: [{ filename: 'spec.md', content: '# spec', created_at: '2024-03-03T00:00:00Z' }],
        },
      ],
    });

    const artifact = items.find((i) => i.type === 'artifact');
    expect(artifact).toBeDefined();
    expect(artifact?.title).toBe('spec.md');
    expect(artifact?.content).toBe('# spec');
    expect(artifact?.metadata.projectName).toBe('Launch');
  });
});

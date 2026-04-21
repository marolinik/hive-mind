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

  // ── 2026-04-22 export format coverage (Sprint 10 Task 1.5 Phase 3) ──

  it('skips project docs with empty content', () => {
    const items = adapter.parse({
      projects: [
        {
          uuid: 'proj-1',
          name: 'Empty',
          docs: [
            { filename: 'blank.md', content: '' },
            { filename: 'stub.md', content: '# real content' },
          ],
        },
      ],
    });
    const artifacts = items.filter((i) => i.type === 'artifact');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('stub.md');
    expect(artifacts[0].metadata.projectUuid).toBe('proj-1');
    expect(artifacts[0].metadata.docUuid).toBeUndefined();
  });

  it('parses memories.conversations_memory as a single memory item', () => {
    const items = adapter.parse({
      memories: [
        {
          conversations_memory: 'User prefers terse responses. Works in Serbia.',
          project_memories: {},
          account_uuid: 'acct-abc',
        },
      ],
    });
    const memories = items.filter((i) => i.type === 'memory');
    expect(memories).toHaveLength(1);
    expect(memories[0].title).toBe('Claude Memory — Conversations');
    expect(memories[0].content).toBe('User prefers terse responses. Works in Serbia.');
    expect(memories[0].metadata.memoryKind).toBe('conversations_memory');
    expect(memories[0].metadata.accountUuid).toBe('acct-abc');
    expect(memories[0].source).toBe('claude');
  });

  it('parses memories.project_memories map into per-project memory items', () => {
    const items = adapter.parse({
      memories: {
        conversations_memory: null,
        project_memories: {
          'proj-a': 'Architecture decisions for project A.',
          'proj-b': 'Key risks for project B.',
        },
        account_uuid: 'acct-xyz',
      },
    });
    const memories = items.filter((i) => i.type === 'memory' && i.metadata.memoryKind === 'project_memory');
    expect(memories).toHaveLength(2);
    const projA = memories.find((m) => m.metadata.projectUuid === 'proj-a');
    expect(projA?.content).toBe('Architecture decisions for project A.');
    expect(projA?.title).toBe('Claude Memory — Project proj-a');
    expect(projA?.metadata.accountUuid).toBe('acct-xyz');
  });

  it('parses design_chats as conversation-typed items with stream metadata', () => {
    const items = adapter.parse({
      design_chats: [
        {
          uuid: 'dc-1',
          title: 'UI feedback thread',
          project: 'proj-a',
          created_at: '2026-03-01T09:00:00Z',
          messages: [
            { uuid: 'm1', role: 'user', content: 'Can we move this button?', created_at: '2026-03-01T09:00:01Z' },
            { uuid: 'm2', role: 'assistant', content: 'Sure, here are three layout options.', created_at: '2026-03-01T09:00:02Z' },
          ],
        },
      ],
    });
    const convItems = items.filter((i) => i.type === 'conversation');
    expect(convItems).toHaveLength(1);
    expect(convItems[0].title).toBe('UI feedback thread');
    expect(convItems[0].messages).toHaveLength(2);
    expect(convItems[0].metadata.stream).toBe('design_chats');
    expect(convItems[0].metadata.designChatUuid).toBe('dc-1');
    expect(convItems[0].metadata.projectUuid).toBe('proj-a');
    expect(convItems[0].timestamp).toBe('2026-03-01T09:00:00Z');
  });

  it('parses a full 2026-04-22 bundle (conversations + projects + memories + design_chats)', () => {
    const items = adapter.parse({
      conversations: [
        {
          uuid: 'c-1',
          name: 'Opening session',
          created_at: '2026-04-20T10:00:00Z',
          chat_messages: [{ sender: 'human', text: 'Hello.', created_at: '2026-04-20T10:00:01Z' }],
        },
      ],
      projects: [
        {
          uuid: 'proj-1',
          name: 'Product',
          updated_at: '2026-04-15T12:00:00Z',
          docs: [{ uuid: 'd-1', filename: 'roadmap.md', content: '# Roadmap' }],
        },
      ],
      memories: [
        {
          conversations_memory: 'User is a founder.',
          project_memories: { 'proj-1': 'Launch date April 2026.' },
          account_uuid: 'acct-1',
        },
      ],
      design_chats: [
        {
          uuid: 'dc-1',
          title: 'Design review',
          created_at: '2026-04-10T15:00:00Z',
          messages: [{ role: 'user', content: 'What about contrast?' }, { role: 'assistant', content: 'Bumped to AA.' }],
        },
      ],
    });

    // Breakdown: 1 conversation + 1 artifact (project doc) + 2 memories + 1 design_chat = 5 items
    expect(items).toHaveLength(5);
    expect(items.filter((i) => i.type === 'conversation')).toHaveLength(2);  // 1 real + 1 design_chat
    expect(items.filter((i) => i.type === 'artifact')).toHaveLength(1);
    expect(items.filter((i) => i.type === 'memory')).toHaveLength(2);

    const artifact = items.find((i) => i.type === 'artifact');
    expect(artifact?.timestamp).toBe('2026-04-15T12:00:00Z');  // falls back to project.updated_at when doc has no created_at
    expect(artifact?.metadata.projectUuid).toBe('proj-1');
  });

  it('handles malformed memories input gracefully (no throw, empty output)', () => {
    // Edge cases: null, array of nulls, string, missing account_uuid
    expect(adapter.parse({ memories: null })).toEqual([]);
    expect(adapter.parse({ memories: 'not-an-object' })).toEqual([]);
    expect(adapter.parse({ memories: [{ conversations_memory: '' }] })).toEqual([]);  // empty string skipped
    expect(adapter.parse({ memories: [{ project_memories: [] }] })).toEqual([]);  // array, not object map → skipped
  });

  it('handles design_chat with no text-bearing messages (returns empty)', () => {
    const items = adapter.parse({
      design_chats: [
        {
          uuid: 'dc-empty',
          title: 'Silent thread',
          messages: [{ role: 'user', content: '' }, { role: 'assistant', content: '   ' }],
        },
      ],
    });
    expect(items).toEqual([]);
  });
});

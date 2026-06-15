import { describe, it, expect } from 'vitest';
import { ChatGPTAdapter } from './chatgpt-adapter.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { UniversalAdapter } from './universal-adapter.js';

/**
 * Caption-aware harvest adapters.
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 *
 * Image content the exports ALREADY carry as text was silently dropped by
 * every adapter. No vision model — these tests assert the text-bearing
 * fields now surface in parsed item content.
 */

describe('caption parity across adapters', () => {
  it('ChatGPT: DALL-E image parts surface their generation prompt', () => {
    const fixture = [{
      title: 'Image chat',
      create_time: 1700000000,
      mapping: {
        n1: {
          message: {
            author: { role: 'user' },
            content: { parts: ['Here is my painting:'] },
            create_time: 1700000001,
          },
        },
        n2: {
          message: {
            author: { role: 'assistant' },
            content: {
              parts: [
                { content_type: 'image_asset_pointer', asset_pointer: 'file://x', metadata: { dalle: { prompt: 'a painting of a sunset with a pink sky' } } },
                'Here you go!',
              ],
            },
            create_time: 1700000002,
          },
        },
      },
    }];
    const items = new ChatGPTAdapter().parse(fixture);
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('[Shared image: a painting of a sunset with a pink sky]');
    expect(items[0].content).toContain('Here you go!');
  });

  it('ChatGPT: message-level attachments surface as presence signals', () => {
    const fixture = [{
      title: 'Attachment chat',
      create_time: 1700000000,
      mapping: {
        n1: {
          message: {
            author: { role: 'user' },
            content: { parts: ['Review this please'] },
            metadata: { attachments: [{ name: 'Q3-roadmap.pdf' }] },
            create_time: 1700000001,
          },
        },
      },
    }];
    const items = new ChatGPTAdapter().parse(fixture);
    expect(items[0].content).toContain('[Attached: Q3-roadmap.pdf]');
  });

  it('Claude: attachment extracted_content surfaces (text already extracted)', () => {
    const fixture = [{
      uuid: 'c1',
      name: 'Doc chat',
      created_at: '2026-05-01T10:00:00Z',
      chat_messages: [
        {
          sender: 'human',
          text: 'Summarize the attached notes',
          created_at: '2026-05-01T10:00:00Z',
          attachments: [{ file_name: 'meeting-notes.txt', extracted_content: 'Launch locked for June 20. Marketing owns the landing page.' }],
        },
      ],
    }];
    const items = new ClaudeAdapter().parse(fixture);
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('[Attached: meeting-notes.txt] Launch locked for June 20');
  });

  it('Claude: an attachment-only message survives (was dropped as empty)', () => {
    const fixture = [{
      uuid: 'c2',
      name: 'Image only',
      created_at: '2026-05-01T10:00:00Z',
      chat_messages: [
        { sender: 'human', text: '', files: [{ file_name: 'whiteboard.png' }] },
        { sender: 'assistant', text: 'Nice whiteboard sketch!' },
      ],
    }];
    const items = new ClaudeAdapter().parse(fixture);
    expect(items[0].content).toContain('[Shared file: whiteboard.png]');
  });

  it('Gemini: fileData/inlineData parts surface as text signals', () => {
    const fixture = {
      conversations: [{
        id: 'g1',
        title: 'Media chat',
        create_time: '2026-05-01T10:00:00Z',
        messages: [
          { role: 'user', parts: [{ text: 'Look at this:' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
          { role: 'model', parts: [{ fileData: { fileUri: 'gs://bucket/diagram.svg', mimeType: 'image/svg+xml' } }, { text: 'Interesting diagram.' }] },
        ],
      }],
    };
    const items = new GeminiAdapter().parse(fixture);
    expect(items.length).toBeGreaterThan(0);
    const all = items.map((i) => i.content).join('\n');
    expect(all).toContain('[Shared media: image/png]');
    expect(all).toContain('[Shared file: gs://bucket/diagram.svg]');
  });

  it('Universal: caption/alt/description fields on object blocks surface', () => {
    const fixture = {
      conversations: [{
        id: 'u1',
        title: 'Generic chat',
        messages: [
          { role: 'user', content: [{ type: 'image', caption: 'a sunset with a palm tree' }, { type: 'text', text: 'What do you think?' }] },
        ],
      }],
    };
    const items = new UniversalAdapter().parse(fixture);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].content).toContain('[Shared image: a sunset with a palm tree]');
  });
});

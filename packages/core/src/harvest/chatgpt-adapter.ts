/**
 * ChatGPT Adapter — parse a ChatGPT JSON export into UniversalImportItems.
 *
 * ChatGPT exports use a `mapping` object keyed by node IDs, each of which
 * holds a message. We flatten that tree by sorting on `create_time`, drop
 * system messages, and emit one `UniversalImportItem` per conversation.
 * Separately, top-level `user_custom_instructions` and `memories` are
 * emitted as their own items (type `instruction` / `memory`) so downstream
 * distillation can treat them as long-lived facts rather than
 * conversation content.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/chatgpt-adapter.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import { randomUUID } from 'node:crypto';
import type { SourceAdapter, UniversalImportItem, ConversationMessage } from './types.js';

export class ChatGPTAdapter implements SourceAdapter {
  readonly sourceType = 'chatgpt' as const;
  readonly displayName = 'ChatGPT';

  parse(input: unknown): UniversalImportItem[] {
    const conversations = Array.isArray(input) ? input : (input as any)?.conversations;
    if (!Array.isArray(conversations)) return [];

    const items: UniversalImportItem[] = [];

    for (const conv of conversations) {
      const title = conv.title || 'Untitled';
      const messages: ConversationMessage[] = [];

      if (conv.mapping && typeof conv.mapping === 'object') {
        const nodes = Object.values(conv.mapping) as any[];
        const sorted = nodes
          .filter((n: any) => n?.message?.content?.parts?.length > 0)
          .sort(
            (a: any, b: any) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0),
          );

        for (const node of sorted) {
          const msg = node.message;
          if (!msg || !msg.author?.role) continue;
          if (msg.author.role === 'system') continue;

          const role = msg.author.role === 'user' ? ('user' as const) : ('assistant' as const);
          const text = (msg.content?.parts ?? [])
            .filter((p: any) => typeof p === 'string')
            .join('\n')
            .trim();
          if (!text) continue;

          messages.push({
            role,
            text,
            timestamp: msg.create_time
              ? new Date(msg.create_time * 1000).toISOString()
              : undefined,
          });
        }
      }

      if (messages.length === 0) continue;

      const customInstructions = conv.custom_instructions;

      items.push({
        id: randomUUID(),
        source: 'chatgpt',
        type: 'conversation',
        title,
        content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
        messages,
        timestamp: conv.create_time
          ? new Date(conv.create_time * 1000).toISOString()
          : new Date().toISOString(),
        metadata: {
          conversationId: conv.id ?? conv.conversation_id,
          messageCount: messages.length,
          ...(customInstructions ? { customInstructions } : {}),
        },
      });
    }

    const root = input as any;
    if (root?.user_custom_instructions) {
      items.push({
        id: randomUUID(),
        source: 'chatgpt',
        type: 'instruction',
        title: 'ChatGPT Custom Instructions',
        content:
          typeof root.user_custom_instructions === 'string'
            ? root.user_custom_instructions
            : JSON.stringify(root.user_custom_instructions),
        timestamp: new Date().toISOString(),
        metadata: { type: 'custom_instructions' },
      });
    }

    if (Array.isArray(root?.memories)) {
      for (const mem of root.memories) {
        const content =
          typeof mem === 'string' ? mem : mem?.content ?? mem?.text ?? JSON.stringify(mem);
        items.push({
          id: randomUUID(),
          source: 'chatgpt',
          type: 'memory',
          title: 'ChatGPT Memory',
          content,
          timestamp: mem?.created_at ?? new Date().toISOString(),
          metadata: { type: 'chatgpt_memory' },
        });
      }
    }

    return items;
  }
}

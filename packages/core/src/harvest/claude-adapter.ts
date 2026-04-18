/**
 * Claude Adapter — parse a Claude web/desktop JSON export into
 * UniversalImportItems.
 *
 * Handles both shapes: a `chat_messages` array per conversation, and the
 * structured content-block format where `msg.content` is an array of typed
 * blocks. Project-knowledge docs attached to a Claude project are emitted
 * as separate `artifact`-typed items.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/claude-adapter.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import { randomUUID } from 'node:crypto';
import type { SourceAdapter, UniversalImportItem, ConversationMessage } from './types.js';

export class ClaudeAdapter implements SourceAdapter {
  readonly sourceType = 'claude' as const;
  readonly displayName = 'Claude';

  parse(input: unknown): UniversalImportItem[] {
    const conversations = Array.isArray(input) ? input : (input as any)?.conversations;
    if (!Array.isArray(conversations)) return [];

    const items: UniversalImportItem[] = [];

    for (const conv of conversations) {
      const title = conv.name || conv.title || 'Untitled';
      const messages: ConversationMessage[] = [];

      const chatMessages = conv.chat_messages ?? conv.messages ?? [];
      for (const msg of chatMessages) {
        const role =
          msg.sender === 'human' || msg.role === 'user'
            ? ('user' as const)
            : ('assistant' as const);

        let text: string;
        if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n')
            .trim();
        } else {
          text = (msg.text ?? msg.content ?? '').trim();
        }
        if (!text) continue;

        messages.push({
          role,
          text,
          timestamp: msg.created_at ?? msg.timestamp,
        });
      }

      if (messages.length === 0) continue;

      items.push({
        id: randomUUID(),
        source: 'claude',
        type: 'conversation',
        title,
        content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
        messages,
        timestamp: conv.created_at ?? conv.create_time ?? new Date().toISOString(),
        metadata: {
          conversationId: conv.uuid ?? conv.id,
          messageCount: messages.length,
          projectId: conv.project_uuid ?? undefined,
        },
      });
    }

    const root = input as any;
    if (Array.isArray(root?.projects)) {
      for (const project of root.projects) {
        if (Array.isArray(project.docs)) {
          for (const doc of project.docs) {
            items.push({
              id: randomUUID(),
              source: 'claude',
              type: 'artifact',
              title: doc.filename ?? doc.title ?? 'Project Document',
              content: doc.content ?? '',
              timestamp: doc.created_at ?? new Date().toISOString(),
              metadata: { projectName: project.name, type: 'project_knowledge' },
            });
          }
        }
      }
    }

    return items;
  }
}

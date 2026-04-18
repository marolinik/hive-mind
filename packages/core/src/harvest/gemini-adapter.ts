/**
 * Gemini Adapter — parse Google Takeout / Gemini conversation exports.
 *
 * Supports three shapes in the wild:
 *   - bare `[{conversation}, ...]` array
 *   - Takeout-style `{conversations: [...]}`
 *   - API-history single-conversation `{history: [...]}`
 *
 * Roles normalize via `resolveRole` ("user"/"human" → user, "model"/
 * "assistant"/"gemini" → assistant). Text extraction handles both the
 * structured `parts[]` format and flat `text` / `content` strings.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/gemini-adapter.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import { randomUUID } from 'node:crypto';
import type { SourceAdapter, UniversalImportItem, ConversationMessage } from './types.js';

export class GeminiAdapter implements SourceAdapter {
  readonly sourceType = 'gemini' as const;
  readonly displayName = 'Gemini';

  parse(input: unknown): UniversalImportItem[] {
    if (Array.isArray(input)) {
      return this.parseConversationArray(input);
    }

    const root = input as any;

    if (Array.isArray(root?.conversations)) {
      return this.parseConversationArray(root.conversations);
    }

    if (Array.isArray(root?.history)) {
      return this.parseSingleConversation(root);
    }

    return [];
  }

  private parseConversationArray(conversations: any[]): UniversalImportItem[] {
    const items: UniversalImportItem[] = [];

    for (const conv of conversations) {
      const title = conv.title ?? conv.name ?? 'Untitled';
      const messages: ConversationMessage[] = [];

      const entries = conv.messages ?? conv.turns ?? conv.history ?? [];
      for (const entry of entries) {
        const role = this.resolveRole(entry);
        if (!role || role === 'system') continue;

        const text = this.extractText(entry);
        if (!text) continue;

        messages.push({
          role,
          text,
          timestamp: entry.createTime ?? entry.create_time ?? entry.timestamp,
        });
      }

      if (messages.length === 0) continue;

      items.push({
        id: randomUUID(),
        source: 'gemini',
        type: 'conversation',
        title,
        content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
        messages,
        timestamp:
          conv.createTime ?? conv.create_time ?? conv.created_at ?? new Date().toISOString(),
        metadata: {
          conversationId: conv.id ?? conv.conversationId,
          messageCount: messages.length,
          model: conv.model ?? conv.modelVersion,
        },
      });
    }

    return items;
  }

  private parseSingleConversation(conv: any): UniversalImportItem[] {
    const messages: ConversationMessage[] = [];
    const entries = conv.history ?? [];

    for (const entry of entries) {
      const role = this.resolveRole(entry);
      if (!role || role === 'system') continue;
      const text = this.extractText(entry);
      if (!text) continue;
      messages.push({ role, text });
    }

    if (messages.length === 0) return [];

    return [
      {
        id: randomUUID(),
        source: 'gemini',
        type: 'conversation',
        title: conv.title ?? 'Gemini Conversation',
        content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
        messages,
        timestamp: new Date().toISOString(),
        metadata: { model: conv.model },
      },
    ];
  }

  private resolveRole(entry: any): 'user' | 'assistant' | 'system' | null {
    const role = entry.role ?? entry.author ?? entry.sender;
    if (!role) return null;
    const r = String(role).toLowerCase();
    if (r === 'user' || r === 'human') return 'user';
    if (r === 'model' || r === 'assistant' || r === 'gemini') return 'assistant';
    if (r === 'system') return 'system';
    return null;
  }

  private extractText(entry: any): string {
    if (Array.isArray(entry.parts)) {
      return entry.parts
        .filter((p: any) => typeof p.text === 'string')
        .map((p: any) => p.text)
        .join('\n')
        .trim();
    }
    if (typeof entry.text === 'string') return entry.text.trim();
    if (typeof entry.content === 'string') return entry.content.trim();
    return '';
  }
}

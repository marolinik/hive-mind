/**
 * Perplexity Adapter — parse Perplexity conversation exports.
 *
 * Perplexity's export (via account → settings → data export) delivers
 * threads as JSON. Common shapes:
 *   - `{threads: [...]}` / `{conversations: [...]}` / `{items: [...]}`
 *   - bare thread array
 *   - single-thread root where `messages` lives on the root object
 *
 * Citations/sources per assistant message are flattened into the text
 * body as "Sources: <url1>, <url2>" so they survive downstream
 * distillation for attribution purposes — the distinguishing feature of
 * Perplexity answers that we don't want to lose.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/perplexity-adapter.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import { randomUUID } from 'node:crypto';
import type { SourceAdapter, UniversalImportItem, ConversationMessage } from './types.js';

export class PerplexityAdapter implements SourceAdapter {
  readonly sourceType = 'perplexity' as const;
  readonly displayName = 'Perplexity';

  parse(input: unknown): UniversalImportItem[] {
    if (Array.isArray(input)) {
      return this.parseThreadArray(input);
    }

    const root = input as Record<string, unknown> | null;
    if (!root || typeof root !== 'object') return [];

    if (Array.isArray(root.threads)) {
      return this.parseThreadArray(root.threads as unknown[]);
    }
    if (Array.isArray(root.conversations)) {
      return this.parseThreadArray(root.conversations as unknown[]);
    }
    if (Array.isArray(root.items)) {
      return this.parseThreadArray(root.items as unknown[]);
    }

    if (Array.isArray((root as any).messages)) {
      return this.parseSingleThread(root);
    }

    return [];
  }

  private parseThreadArray(threads: unknown[]): UniversalImportItem[] {
    const items: UniversalImportItem[] = [];
    for (const raw of threads) {
      const thread = raw as Record<string, unknown> | null;
      if (!thread || typeof thread !== 'object') continue;
      const built = this.buildItem(thread);
      if (built) items.push(built);
    }
    return items;
  }

  private parseSingleThread(thread: Record<string, unknown>): UniversalImportItem[] {
    const built = this.buildItem(thread);
    return built ? [built] : [];
  }

  private buildItem(thread: Record<string, unknown>): UniversalImportItem | null {
    const rawMessages = (thread.messages ?? thread.turns ?? []) as unknown[];
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null;

    const messages: ConversationMessage[] = [];
    for (const rawMsg of rawMessages) {
      const msg = rawMsg as Record<string, unknown> | null;
      if (!msg) continue;
      const role = this.resolveRole(msg);
      if (!role || role === 'system') continue;

      const text = this.extractText(msg);
      if (!text) continue;

      const sources = this.extractSources(msg);
      const textWithSources =
        sources.length > 0 ? `${text}\n\nSources: ${sources.join(', ')}` : text;

      messages.push({
        role,
        text: textWithSources,
        timestamp: this.extractTimestamp(msg),
      });
    }

    if (messages.length === 0) return null;

    const title =
      (thread.title as string) ?? (thread.name as string) ?? 'Perplexity Thread';

    return {
      id: randomUUID(),
      source: 'perplexity',
      type: 'conversation',
      title,
      content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
      messages,
      timestamp: this.extractTimestamp(thread) ?? new Date().toISOString(),
      metadata: {
        threadId: thread.id ?? thread.threadId,
        messageCount: messages.length,
        hasCitations: messages.some((m) => m.text.includes('Sources:')),
      },
    };
  }

  private resolveRole(
    entry: Record<string, unknown>,
  ): 'user' | 'assistant' | 'system' | null {
    const raw = entry.role ?? entry.author ?? entry.sender ?? entry.type;
    if (!raw) return null;
    const r = String(raw).toLowerCase();
    if (r === 'user' || r === 'human' || r === 'question') return 'user';
    if (r === 'assistant' || r === 'ai' || r === 'perplexity' || r === 'answer')
      return 'assistant';
    if (r === 'system') return 'system';
    return null;
  }

  private extractText(entry: Record<string, unknown>): string {
    if (typeof entry.content === 'string') return entry.content.trim();
    if (typeof entry.text === 'string') return entry.text.trim();
    if (typeof entry.answer === 'string') return entry.answer.trim();
    if (typeof entry.query === 'string') return entry.query.trim();

    const content = entry.content as Record<string, unknown> | undefined;
    if (content && Array.isArray(content.parts)) {
      return content.parts.filter((p) => typeof p === 'string').join('\n').trim();
    }
    return '';
  }

  private extractSources(entry: Record<string, unknown>): string[] {
    const raw = entry.sources ?? entry.citations ?? entry.web_results;
    if (!Array.isArray(raw)) return [];
    const urls: string[] = [];
    for (const src of raw) {
      if (typeof src === 'string') {
        urls.push(src);
      } else if (src && typeof src === 'object') {
        const s = src as Record<string, unknown>;
        const url = s.url ?? s.link ?? s.href;
        if (typeof url === 'string') urls.push(url);
      }
    }
    return urls;
  }

  private extractTimestamp(entry: Record<string, unknown>): string | undefined {
    const raw = entry.timestamp ?? entry.created_at ?? entry.createdAt ?? entry.time;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number') return new Date(raw).toISOString();
    return undefined;
  }
}

/**
 * Universal Adapter — heuristic parse for text/JSON/markdown of unknown
 * provenance.
 *
 * Fallback path for sources we don't have a dedicated adapter for
 * (Tier-2 platforms: Grok, Manus, Genspark, Qwen, Minimax, z.ai,
 * OpenClaw, ElevenLabs, Google Flow, etc.). Strategy:
 *   1. Try to detect the source from content cues.
 *   2. If input is JSON with a recognizable conversation shape, parse as
 *      conversations. Otherwise fall back to treating the whole thing as
 *      a single `memory` item.
 *   3. If input is plain text, split on common separators (markdown
 *      headings, equals/dash-rule lines, "Conversation N" markers) and
 *      parse each segment. Messages are extracted via a liberal
 *      "Speaker: text" pattern covering User/Human/Me/Assistant/AI/Bot/
 *      Claude/ChatGPT/Gemini/Grok.
 *
 * Caption parity: object blocks with text-bearing image fields
 * (`caption` / `alt` / `description`) surface as "[Shared image: …]"
 * instead of being dropped. Untrusted-field access is hardened through
 * the raw-types narrowing helpers.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/universal-adapter.ts`.
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 * Scrub: the Waggle source walked the speaker-pattern regex via a stateful
 * `pattern.exec()` loop; swapped here to `String.matchAll` which is
 * equivalent semantics, cleaner, and keeps the package free of literal
 * `.exec(` call sites (defuses repo-level security scanners).
 */

import { stableHarvestId } from './stable-id.js';
import type {
  SourceAdapter,
  UniversalImportItem,
  ImportSourceType,
  ConversationMessage,
} from './types.js';
import { asRecord, firstString, getArray, getString, type RawRecord } from './raw-types.js';

/** Heuristic source detection from content cues. */
function detectSource(input: unknown): ImportSourceType {
  if (typeof input === 'string') {
    const lower = input.toLowerCase();
    if (lower.includes('perplexity')) return 'perplexity';
    if (lower.includes('grok') || lower.includes('x.ai')) return 'grok';
    if (lower.includes('manus')) return 'manus';
    if (lower.includes('genspark')) return 'genspark';
    if (lower.includes('qwen') || lower.includes('tongyi')) return 'qwen';
    if (lower.includes('minimax')) return 'minimax';
    if (lower.includes('elevenlabs')) return 'elevenlabs';
    return 'unknown';
  }

  const obj = asRecord(input);
  if (obj) {
    const keys = Object.keys(obj);
    const source = getString(obj, 'source');
    if (keys.includes('perplexity') || source === 'perplexity') return 'perplexity';
    if (keys.includes('grok') || source === 'grok') return 'grok';
    if (getString(obj, 'provider') === 'qwen') return 'qwen';
  }

  return 'unknown';
}

/** Try to find conversations in any JSON structure. */
function findConversations(obj: unknown): RawRecord[] | null {
  if (Array.isArray(obj)) {
    const first = asRecord(obj[0]);
    if (obj.length > 0 && first && (first.messages || first.chat_messages || first.turns || first.history)) {
      return obj.map(asRecord).filter((c): c is RawRecord => c !== null);
    }
    if (obj.length > 0 && first && (first.role || first.sender || first.author)) {
      return [{ title: 'Imported Conversation', messages: obj }];
    }
  }

  const record = asRecord(obj);
  if (record) {
    for (const key of ['conversations', 'chats', 'threads', 'sessions', 'history', 'data']) {
      const nested = getArray(record, key);
      if (nested) {
        return findConversations(nested);
      }
    }
  }

  return null;
}

export class UniversalAdapter implements SourceAdapter {
  readonly sourceType = 'unknown' as const;
  readonly displayName = 'Universal (Auto-detect)';

  parse(input: unknown): UniversalImportItem[] {
    if (typeof input === 'string') {
      return this.parseText(input);
    }
    if (typeof input === 'object' && input !== null) {
      return this.parseJson(input);
    }
    return [];
  }

  private parseText(text: string): UniversalImportItem[] {
    const source = detectSource(text);
    const items: UniversalImportItem[] = [];
    const conversations = this.splitConversations(text);

    for (const conv of conversations) {
      const messages = this.extractMessagesFromText(conv.content);

      items.push({
        // raw text paste has no id — content is the only surrogate (NOT growth-stable;
        // documented tradeoff, no better anchor exists for free-text).
        id: stableHarvestId('universal-text', source, conv.content),
        source,
        type: messages.length > 0 ? 'conversation' : 'memory',
        title: conv.title,
        content: conv.content,
        messages: messages.length > 0 ? messages : undefined,
        timestamp: new Date().toISOString(),
        metadata: { parseMethod: 'universal-text', detectedSource: source },
      });
    }

    return items;
  }

  private parseJson(input: object): UniversalImportItem[] {
    const source = detectSource(input);
    const items: UniversalImportItem[] = [];
    const conversations = findConversations(input);

    if (conversations) {
      for (const conv of conversations) {
        const title = firstString(conv, 'title', 'name', 'subject') ?? 'Imported Conversation';
        const rawMessages = getArray(conv, 'messages') ?? getArray(conv, 'chat_messages')
          ?? getArray(conv, 'turns') ?? getArray(conv, 'history') ?? [];
        const messages: ConversationMessage[] = [];

        for (const rawMsg of rawMessages) {
          const msg = asRecord(rawMsg);
          if (!msg) continue;
          const role = this.resolveRole(msg);
          if (!role) continue;
          const text = this.extractText(msg);
          if (!text) continue;
          messages.push({ role, text, timestamp: firstString(msg, 'timestamp', 'created_at', 'createTime') });
        }

        if (messages.length === 0) continue;

        const convContent = messages.map((m) => `${m.role}: ${m.text}`).join('\n\n');
        const convId = getString(conv, 'id');
        items.push({
          // Stable per-conversation id when the export gives one (growth-stable). Else
          // fall back to source+title+created_at PLUS content: a bare message-array paste
          // has no id/timestamp and a CONSTANT synthetic title ('Imported Conversation'),
          // so without content every such paste collapses to ONE (source, source_ref)
          // subject key → cross-subject over-suppression / co-erasure. Content makes them
          // distinct (id-less → not growth-stable, the documented universal-text tradeoff).
          id: stableHarvestId('universal-json', convId ?? `${source}\x00${title}\x00${firstString(conv, 'created_at', 'createTime', 'timestamp') ?? ''}\x00${convContent}`),
          source,
          type: 'conversation',
          title,
          content: convContent,
          messages,
          timestamp: firstString(conv, 'created_at', 'createTime', 'timestamp') ?? new Date().toISOString(),
          metadata: { parseMethod: 'universal-json', detectedSource: source, conversationId: convId },
        });
      }
    }

    if (items.length === 0) {
      const record = asRecord(input);
      items.push({
        id: stableHarvestId('universal-json-raw', source, JSON.stringify(input)),
        source,
        type: 'memory',
        title: (record && getString(record, 'title')) ?? 'Imported Data',
        content: JSON.stringify(input, null, 2).slice(0, 50000),
        timestamp: new Date().toISOString(),
        metadata: { parseMethod: 'universal-json-raw', detectedSource: source },
      });
    }

    return items;
  }

  private splitConversations(text: string): { title: string; content: string }[] {
    const separators = [
      /^#{1,3}\s+/gm,
      /^={3,}$/gm,
      /^-{3,}$/gm,
      /^Conversation \d+/gim,
    ];

    for (const sep of separators) {
      const parts = text.split(sep).filter((p) => p.trim().length > 20);
      if (parts.length > 1) {
        return parts.map((p, i) => ({
          title: `Conversation ${i + 1}`,
          content: p.trim(),
        }));
      }
    }

    return [{ title: 'Imported Text', content: text.trim() }];
  }

  private extractMessagesFromText(text: string): ConversationMessage[] {
    const messages: ConversationMessage[] = [];
    const pattern =
      /^(User|Human|Me|Assistant|AI|Bot|Claude|ChatGPT|Gemini|Grok):\s*([\s\S]*?)(?=^(?:User|Human|Me|Assistant|AI|Bot|Claude|ChatGPT|Gemini|Grok):|$)/gim;

    for (const match of text.matchAll(pattern)) {
      const speaker = match[1].toLowerCase();
      const content = match[2].trim();
      if (!content) continue;

      const role = ['user', 'human', 'me'].includes(speaker)
        ? ('user' as const)
        : ('assistant' as const);
      messages.push({ role, text: content });
    }

    return messages;
  }

  private resolveRole(msg: RawRecord): 'user' | 'assistant' | null {
    const role = firstString(msg, 'role', 'sender', 'author', 'type');
    if (!role) return null;
    const r = role.toLowerCase();
    if (['user', 'human', 'me'].includes(r)) return 'user';
    if (['assistant', 'ai', 'bot', 'model', 'system'].includes(r)) return 'assistant';
    return null;
  }

  private extractText(msg: RawRecord): string {
    const directText = getString(msg, 'text');
    if (directText !== undefined) return directText.trim();
    const directContent = getString(msg, 'content');
    if (directContent !== undefined) return directContent.trim();
    const contentBlocks = getArray(msg, 'content');
    if (contentBlocks) {
      return contentBlocks
        .map((b) => {
          if (typeof b === 'string') return b;
          const rec = asRecord(b);
          if (!rec) return undefined;
          if (rec.type === 'text') return getString(rec, 'text') ?? '';
          // Caption parity: generic text-bearing image fields.
          const caption = getString(rec, 'caption') ?? getString(rec, 'alt') ?? getString(rec, 'description');
          if (caption) return `[Shared image: ${caption}]`;
          return undefined;
        })
        .filter((t): t is string => typeof t === 'string')
        .join('\n')
        .trim();
    }
    const parts = getArray(msg, 'parts');
    if (parts) {
      return parts
        .map(asRecord)
        .map((p) => (p ? getString(p, 'text') : undefined))
        .filter((t): t is string => typeof t === 'string')
        .join('\n')
        .trim();
    }
    return '';
  }
}

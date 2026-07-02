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
 * Caption parity: media parts were silently dropped — `fileData` parts
 * surface as "[Shared file: uri|mime]" and `inlineData` parts as
 * "[Shared media: mime]" presence signals. Untrusted-field access is
 * hardened through the raw-types narrowing helpers.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/gemini-adapter.ts`.
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 * Scrub: none — this module has no proprietary dependencies.
 */

import { stableHarvestId } from './stable-id.js';
import type { SourceAdapter, UniversalImportItem, ConversationMessage } from './types.js';
import { asRecord, firstString, getArray, getString, type RawRecord } from './raw-types.js';

export class GeminiAdapter implements SourceAdapter {
  readonly sourceType = 'gemini' as const;
  readonly displayName = 'Gemini';

  parse(input: unknown): UniversalImportItem[] {
    // Handle different Gemini export formats
    if (Array.isArray(input)) {
      return this.parseConversationArray(input);
    }

    const root = asRecord(input);
    if (!root) return [];

    // Google Takeout format: { conversations: [...] }
    const conversations = getArray(root, 'conversations');
    if (conversations) {
      return this.parseConversationArray(conversations);
    }

    // Gemini API history format: { history: [...] }
    if (getArray(root, 'history')) {
      return this.parseSingleConversation(root);
    }

    return [];
  }

  private parseConversationArray(conversations: unknown[]): UniversalImportItem[] {
    const items: UniversalImportItem[] = [];

    for (const rawConv of conversations) {
      const conv = asRecord(rawConv);
      if (!conv) continue;
      const title = firstString(conv, 'title', 'name') ?? 'Untitled';
      const messages: ConversationMessage[] = [];

      const entries = getArray(conv, 'messages') ?? getArray(conv, 'turns') ?? getArray(conv, 'history') ?? [];
      for (const rawEntry of entries) {
        const entry = asRecord(rawEntry);
        if (!entry) continue;
        const role = this.resolveRole(entry);
        if (!role || role === 'system') continue;

        const text = this.extractText(entry);
        if (!text) continue;

        messages.push({
          role,
          text,
          timestamp: firstString(entry, 'createTime', 'create_time', 'timestamp'),
        });
      }

      if (messages.length === 0) continue;

      items.push({
        // #7 sticky erasure: conversation id (Takeout export id), not content.
        id: stableHarvestId('gemini', firstString(conv, 'id', 'conversationId') ?? `${title}\x00${firstString(conv, 'createTime', 'create_time', 'created_at') ?? ''}`),
        source: 'gemini',
        type: 'conversation',
        title,
        content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
        messages,
        timestamp: firstString(conv, 'createTime', 'create_time', 'created_at') ?? new Date().toISOString(),
        metadata: {
          conversationId: firstString(conv, 'id', 'conversationId'),
          messageCount: messages.length,
          model: firstString(conv, 'model', 'modelVersion'),
        },
      });
    }

    return items;
  }

  private parseSingleConversation(conv: RawRecord): UniversalImportItem[] {
    const messages: ConversationMessage[] = [];
    const entries = getArray(conv, 'history') ?? [];

    for (const rawEntry of entries) {
      const entry = asRecord(rawEntry);
      if (!entry) continue;
      const role = this.resolveRole(entry);
      if (!role || role === 'system') continue;
      const text = this.extractText(entry);
      if (!text) continue;
      messages.push({ role, text });
    }

    if (messages.length === 0) return [];

    return [{
      // {history} API dump carries no id — title+model is the only stable surrogate
      // (documented collision risk for two same-title+model dumps; no better anchor).
      id: stableHarvestId('gemini', getString(conv, 'title') ?? 'Gemini Conversation', getString(conv, 'model') ?? ''),
      source: 'gemini',
      type: 'conversation',
      title: getString(conv, 'title') ?? 'Gemini Conversation',
      content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
      messages,
      timestamp: new Date().toISOString(),
      metadata: { model: getString(conv, 'model') },
    }];
  }

  private resolveRole(entry: RawRecord): 'user' | 'assistant' | 'system' | null {
    const role = firstString(entry, 'role', 'author', 'sender');
    if (!role) return null;
    const r = role.toLowerCase();
    if (r === 'user' || r === 'human') return 'user';
    if (r === 'model' || r === 'assistant' || r === 'gemini') return 'assistant';
    if (r === 'system') return 'system';
    return null;
  }

  private extractText(entry: RawRecord): string {
    // Gemini parts format: { parts: [{ text: "..." }] }
    const parts = getArray(entry, 'parts');
    if (parts) {
      return parts
        .map(asRecord)
        .map((p) => {
          if (!p) return undefined;
          const t = getString(p, 'text');
          if (t !== undefined) return t;
          // Caption parity: media parts were silently dropped. Surface the
          // text-bearing fields the export carries — file URI/name for
          // fileData, mime type as a presence signal for inline images
          // ("did X share a photo?" questions).
          const fd = asRecord(p.fileData) ?? asRecord(p.file_data);
          if (fd) {
            const uri = getString(fd, 'fileUri') ?? getString(fd, 'file_uri') ?? getString(fd, 'displayName');
            const mime = getString(fd, 'mimeType') ?? getString(fd, 'mime_type');
            return `[Shared file: ${uri ?? mime ?? 'media'}]`;
          }
          const il = asRecord(p.inlineData) ?? asRecord(p.inline_data);
          if (il) {
            const mime = getString(il, 'mimeType') ?? getString(il, 'mime_type');
            return mime ? `[Shared media: ${mime}]` : undefined;
          }
          return undefined;
        })
        .filter((t): t is string => typeof t === 'string')
        .join('\n')
        .trim();
    }
    // Simple text field
    const text = getString(entry, 'text');
    if (text !== undefined) return text.trim();
    const content = getString(entry, 'content');
    if (content !== undefined) return content.trim();
    return '';
  }
}

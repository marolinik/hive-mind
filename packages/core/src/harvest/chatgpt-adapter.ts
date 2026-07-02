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
 * Caption parity: multimodal object parts were silently dropped — DALL-E
 * image parts carry their generation prompt (metadata.dalle.prompt), the
 * only text-bearing image field in ChatGPT exports. Rendered as
 * "[Shared image: …]". Message-level attachment names surface as
 * "[Attached: …]" presence signals. Untrusted-field access is hardened
 * through the raw-types narrowing helpers.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/chatgpt-adapter.ts`.
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 * Scrub: none — this module has no proprietary dependencies.
 */

import { stableHarvestId } from './stable-id.js';
import type { SourceAdapter, UniversalImportItem, ConversationMessage } from './types.js';
import { asRecord, getArray, getNumber, getString, type RawRecord } from './raw-types.js';

export class ChatGPTAdapter implements SourceAdapter {
  readonly sourceType = 'chatgpt' as const;
  readonly displayName = 'ChatGPT';

  parse(input: unknown): UniversalImportItem[] {
    const root = asRecord(input);
    const conversations = Array.isArray(input) ? input : root && getArray(root, 'conversations');
    if (!Array.isArray(conversations)) return [];

    const items: UniversalImportItem[] = [];

    for (const rawConv of conversations) {
      const conv = asRecord(rawConv);
      if (!conv) continue;
      const title = getString(conv, 'title') || 'Untitled';
      const messages: ConversationMessage[] = [];

      // ChatGPT uses a mapping object with node IDs
      const mapping = asRecord(conv.mapping);
      if (mapping) {
        const nodes = Object.values(mapping)
          .map(asRecord)
          .filter((n): n is RawRecord => n !== null);
        const sorted = nodes
          .filter((n) => {
            const msg = asRecord(n.message);
            const content = msg && asRecord(msg.content);
            const parts = content && getArray(content, 'parts');
            return (parts?.length ?? 0) > 0;
          })
          .sort((a, b) => {
            const am = asRecord(a.message);
            const bm = asRecord(b.message);
            return (am && getNumber(am, 'create_time') ? getNumber(am, 'create_time')! : 0)
              - (bm && getNumber(bm, 'create_time') ? getNumber(bm, 'create_time')! : 0);
          });

        for (const node of sorted) {
          const msg = asRecord(node.message);
          const author = msg && asRecord(msg.author);
          const authorRole = author && getString(author, 'role');
          if (!msg || !authorRole) continue;
          if (authorRole === 'system') continue;

          const role = authorRole === 'user' ? ('user' as const) : ('assistant' as const);
          const content = asRecord(msg.content);
          const parts = content ? getArray(content, 'parts') : undefined;
          // Caption parity: DALL-E image parts carry their generation prompt
          // — surface it as "[Shared image: …]" instead of dropping the part.
          const textParts: string[] = [];
          for (const p of parts ?? []) {
            if (typeof p === 'string') { textParts.push(p); continue; }
            const rec = asRecord(p);
            if (!rec) continue;
            const ct = getString(rec, 'content_type') ?? '';
            if (ct.includes('image')) {
              const meta = asRecord(rec.metadata);
              const dalle = meta ? asRecord(meta.dalle) : null;
              const prompt = dalle ? getString(dalle, 'prompt') : undefined;
              if (prompt) textParts.push(`[Shared image: ${prompt}]`);
            }
          }
          // Message-level attachments: names are text-bearing presence signals.
          const msgMeta = asRecord(msg.metadata);
          for (const rawAtt of (msgMeta ? getArray(msgMeta, 'attachments') : undefined) ?? []) {
            const att = asRecord(rawAtt);
            const name = att ? getString(att, 'name') : undefined;
            if (name) textParts.push(`[Attached: ${name}]`);
          }
          const text = textParts.join('\n').trim();
          if (!text) continue;

          const createTime = getNumber(msg, 'create_time');
          messages.push({
            role,
            text,
            timestamp: createTime ? new Date(createTime * 1000).toISOString() : undefined,
          });
        }
      }

      if (messages.length === 0) continue;

      // Also check for custom instructions in conversation metadata
      const customInstructions = conv.custom_instructions;
      const createTime = getNumber(conv, 'create_time');

      items.push({
        // #7 sticky erasure: stable per-conversation id (keyed on the export's own
        // conversation id, NOT content, so a grown conversation keeps its id).
        id: stableHarvestId('chatgpt', getString(conv, 'id') ?? getString(conv, 'conversation_id') ?? `conv\x00${title}\x00${createTime ?? ''}`),
        source: 'chatgpt',
        type: 'conversation',
        title,
        content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
        messages,
        timestamp: createTime ? new Date(createTime * 1000).toISOString() : new Date().toISOString(),
        metadata: {
          conversationId: getString(conv, 'id') ?? getString(conv, 'conversation_id'),
          messageCount: messages.length,
          ...(customInstructions ? { customInstructions } : {}),
        },
      });
    }

    // Also extract custom instructions / memory as separate items
    if (root?.user_custom_instructions) {
      items.push({
        // 'singleton' discriminator (2 parts) so this can't collide with a
        // conversation whose conv.id is literally the string 'custom_instructions'.
        id: stableHarvestId('chatgpt', 'singleton', 'custom_instructions'),
        source: 'chatgpt',
        type: 'instruction',
        title: 'ChatGPT Custom Instructions',
        content: typeof root.user_custom_instructions === 'string'
          ? root.user_custom_instructions
          : JSON.stringify(root.user_custom_instructions),
        timestamp: new Date().toISOString(),
        metadata: { type: 'custom_instructions' },
      });
    }

    const memories = root && getArray(root, 'memories');
    if (memories) {
      for (const rawMem of memories) {
        const mem = asRecord(rawMem);
        const content = typeof rawMem === 'string'
          ? rawMem
          : (mem && (getString(mem, 'content') ?? getString(mem, 'text'))) ?? JSON.stringify(rawMem);
        items.push({
          // No stable per-memory id exists in the export, so key on created_at+content
          // (the best available surrogate). Caveat: ChatGPT memories are user-editable,
          // so an EDIT changes the id → erasure isn't sticky across an edit (bounded,
          // documented tradeoff — same class as the universal-text content-keyed path).
          id: stableHarvestId('chatgpt', 'memory', (mem && getString(mem, 'created_at')) ?? '', content),
          source: 'chatgpt',
          type: 'memory',
          title: 'ChatGPT Memory',
          content,
          timestamp: (mem && getString(mem, 'created_at')) ?? new Date().toISOString(),
          metadata: { type: 'chatgpt_memory' },
        });
      }
    }

    return items;
  }
}

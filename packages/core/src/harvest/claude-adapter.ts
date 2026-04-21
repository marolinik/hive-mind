/**
 * Claude Adapter — parse a Claude web/desktop JSON export into
 * UniversalImportItems.
 *
 * Handles multiple shapes of the Claude export:
 *   - Raw `chat_messages` array per conversation
 *   - Structured content-block format where `msg.content` is typed blocks
 *   - `projects[].docs[]` project-knowledge documents → type='artifact'
 *   - `memories` (conversations_memory + project_memories map) → type='memory'
 *   - `design_chats[]` Claude design workspace threads → type='conversation'
 *
 * The four new content streams (projects docs, memories, design_chats) came
 * online in the 2026-04-22 Claude.ai export refresh. See the Sprint 10
 * Task 1.5 verification report (`waggle-os/preflight-results/
 * claude-ai-export-verification-2026-04-22.md`) for the export structure
 * analysis that motivated this extension.
 *
 * Session-generated `/mnt/user-data/outputs/*` artifacts referenced in
 * chat turns via `computer://` URLs are still NOT available in the export
 * as of 2026-04-22 — that gap remains tracked as hive-mind BACKLOG P1
 * ("Harvest Claude artifacts adapter"). This adapter covers the three
 * content streams that ARE in the export; session artifacts stay parked.
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
    const items: UniversalImportItem[] = [];

    // ── Conversations (historical default path) ───────────────────────
    const conversations = Array.isArray(input)
      ? input
      : (input as { conversations?: unknown })?.conversations;
    if (Array.isArray(conversations)) {
      for (const conv of conversations) {
        items.push(...this.parseConversation(conv));
      }
    }

    const root = input as {
      projects?: unknown;
      memories?: unknown;
      design_chats?: unknown;
    };

    // ── Project-knowledge docs → artifact items ──────────────────────
    if (Array.isArray(root?.projects)) {
      for (const project of root.projects) {
        items.push(...this.parseProjectDocs(project));
      }
    }

    // ── Memories stream (conversations_memory + project_memories) ────
    if (root?.memories !== undefined) {
      items.push(...this.parseMemories(root.memories));
    }

    // ── Design chats stream ──────────────────────────────────────────
    if (Array.isArray(root?.design_chats)) {
      for (const dc of root.design_chats) {
        items.push(...this.parseDesignChat(dc));
      }
    }

    return items;
  }

  private parseConversation(conv: unknown): UniversalImportItem[] {
    if (typeof conv !== 'object' || conv === null) return [];
    const c = conv as Record<string, unknown>;
    const title = (c.name as string | undefined) ?? (c.title as string | undefined) ?? 'Untitled';
    const messages: ConversationMessage[] = [];

    const chatMessages = (c.chat_messages as unknown[] | undefined) ?? (c.messages as unknown[] | undefined) ?? [];
    for (const rawMsg of chatMessages) {
      if (typeof rawMsg !== 'object' || rawMsg === null) continue;
      const msg = rawMsg as Record<string, unknown>;
      const role =
        msg.sender === 'human' || msg.role === 'user'
          ? ('user' as const)
          : ('assistant' as const);

      let text: string;
      if (Array.isArray(msg.content)) {
        text = (msg.content as unknown[])
          .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
          .map((b) => (b.text as string | undefined) ?? '')
          .join('\n')
          .trim();
      } else {
        text = String(msg.text ?? msg.content ?? '').trim();
      }
      if (!text) continue;

      messages.push({
        role,
        text,
        timestamp: (msg.created_at as string | undefined) ?? (msg.timestamp as string | undefined),
      });
    }

    if (messages.length === 0) return [];

    return [{
      id: randomUUID(),
      source: 'claude',
      type: 'conversation',
      title,
      content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
      messages,
      timestamp: (c.created_at as string | undefined) ?? (c.create_time as string | undefined) ?? new Date().toISOString(),
      metadata: {
        conversationId: (c.uuid as string | undefined) ?? (c.id as string | undefined),
        messageCount: messages.length,
        projectId: (c.project_uuid as string | undefined) ?? undefined,
      },
    }];
  }

  private parseProjectDocs(project: unknown): UniversalImportItem[] {
    if (typeof project !== 'object' || project === null) return [];
    const p = project as Record<string, unknown>;
    const docs = p.docs as unknown[] | undefined;
    if (!Array.isArray(docs)) return [];
    const out: UniversalImportItem[] = [];
    for (const rawDoc of docs) {
      if (typeof rawDoc !== 'object' || rawDoc === null) continue;
      const doc = rawDoc as Record<string, unknown>;
      const content = typeof doc.content === 'string' ? doc.content : '';
      if (content.length === 0) continue;
      out.push({
        id: randomUUID(),
        source: 'claude',
        type: 'artifact',
        title: (doc.filename as string | undefined) ?? (doc.title as string | undefined) ?? 'Project Document',
        content,
        timestamp:
          (doc.created_at as string | undefined)
          ?? (p.updated_at as string | undefined)
          ?? (p.created_at as string | undefined)
          ?? new Date().toISOString(),
        metadata: {
          projectName: p.name as string | undefined,
          projectUuid: p.uuid as string | undefined,
          type: 'project_knowledge',
          docUuid: doc.uuid as string | undefined,
          filename: doc.filename as string | undefined,
        },
      });
    }
    return out;
  }

  private parseMemories(input: unknown): UniversalImportItem[] {
    // `memories.json` is a single-entry array per the 2026-04-22 export
    // shape: `[{ conversations_memory, project_memories, account_uuid }]`.
    // Accept both the array-wrapped form and a bare object for flexibility.
    const arr = Array.isArray(input) ? input : [input];
    const out: UniversalImportItem[] = [];

    for (const entry of arr) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const accountUuid = typeof e.account_uuid === 'string' ? e.account_uuid : undefined;

      // conversations_memory — usually a single long string of user-about facts
      if (e.conversations_memory !== undefined && e.conversations_memory !== null) {
        const content = typeof e.conversations_memory === 'string'
          ? e.conversations_memory
          : JSON.stringify(e.conversations_memory);
        if (content.length > 0) {
          out.push({
            id: randomUUID(),
            source: 'claude',
            type: 'memory',
            title: 'Claude Memory — Conversations',
            content,
            timestamp: new Date().toISOString(),
            metadata: {
              memoryKind: 'conversations_memory',
              accountUuid,
            },
          });
        }
      }

      // project_memories — map of project_uuid -> memory string
      if (e.project_memories !== undefined && e.project_memories !== null) {
        const pm = e.project_memories;
        if (typeof pm === 'object' && !Array.isArray(pm)) {
          for (const [projUuid, memValue] of Object.entries(pm as Record<string, unknown>)) {
            const content = typeof memValue === 'string'
              ? memValue
              : JSON.stringify(memValue);
            if (content.length > 0) {
              out.push({
                id: randomUUID(),
                source: 'claude',
                type: 'memory',
                title: `Claude Memory — Project ${projUuid}`,
                content,
                timestamp: new Date().toISOString(),
                metadata: {
                  memoryKind: 'project_memory',
                  projectUuid: projUuid,
                  accountUuid,
                },
              });
            }
          }
        }
      }
    }

    return out;
  }

  private parseDesignChat(input: unknown): UniversalImportItem[] {
    if (typeof input !== 'object' || input === null) return [];
    const dc = input as Record<string, unknown>;
    const messages: ConversationMessage[] = [];
    const msgs = (dc.messages as unknown[] | undefined) ?? (dc.chat_messages as unknown[] | undefined) ?? [];

    for (const rawMsg of msgs) {
      if (typeof rawMsg !== 'object' || rawMsg === null) continue;
      const m = rawMsg as Record<string, unknown>;
      const role =
        m.role === 'user' || m.sender === 'human'
          ? ('user' as const)
          : ('assistant' as const);

      let text: string;
      if (Array.isArray(m.content)) {
        text = (m.content as unknown[])
          .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
          .map((b) => (b.text as string | undefined) ?? '')
          .join('\n')
          .trim();
      } else {
        text = String(m.text ?? m.content ?? '').trim();
      }
      if (!text) continue;

      messages.push({
        role,
        text,
        timestamp: (m.created_at as string | undefined) ?? (m.timestamp as string | undefined),
      });
    }

    if (messages.length === 0) return [];

    return [{
      id: randomUUID(),
      source: 'claude',
      type: 'conversation',
      title: (dc.title as string | undefined) ?? 'Claude Design Chat',
      content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
      messages,
      timestamp: (dc.created_at as string | undefined) ?? new Date().toISOString(),
      metadata: {
        designChatUuid: dc.uuid as string | undefined,
        projectUuid: (dc.project as string | undefined) ?? undefined,
        messageCount: messages.length,
        stream: 'design_chats',
      },
    }];
  }
}

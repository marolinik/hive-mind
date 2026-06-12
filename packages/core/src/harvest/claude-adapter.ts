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
 * Caption parity: message-level `attachments` / `files` arrays surface
 * their text content — `extracted_content` is inlined as
 * "[Attached: name] …" (capped 500 chars), bare names as
 * "[Shared file: name]". Untrusted-field access is hardened through the
 * raw-types narrowing helpers.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/claude-adapter.ts`.
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 * Scrub: none — this module has no proprietary dependencies.
 */

import { randomUUID } from 'node:crypto';
import type { SourceAdapter, UniversalImportItem, ConversationMessage } from './types.js';
import { asRecord, firstString, getArray, getString, type RawRecord } from './raw-types.js';

export class ClaudeAdapter implements SourceAdapter {
  readonly sourceType = 'claude' as const;
  readonly displayName = 'Claude';

  parse(input: unknown): UniversalImportItem[] {
    const items: UniversalImportItem[] = [];
    const root = asRecord(input);

    // ── Conversations (historical default path) ───────────────────────
    const conversations = Array.isArray(input) ? input : root && getArray(root, 'conversations');
    if (Array.isArray(conversations)) {
      for (const conv of conversations) {
        items.push(...this.parseConversation(conv));
      }
    }

    // ── Project-knowledge docs → artifact items ──────────────────────
    const projects = root && getArray(root, 'projects');
    if (projects) {
      for (const project of projects) {
        items.push(...this.parseProjectDocs(project));
      }
    }

    // ── Memories stream (conversations_memory + project_memories) ────
    if (root && root.memories !== undefined) {
      items.push(...this.parseMemories(root.memories));
    }

    // ── Design chats stream ──────────────────────────────────────────
    const designChats = root && getArray(root, 'design_chats');
    if (designChats) {
      for (const dc of designChats) {
        items.push(...this.parseDesignChat(dc));
      }
    }

    return items;
  }

  /**
   * Parse one Claude chat message (conversation or design-chat shape) into a
   * ConversationMessage, applying the attachment/caption extraction.
   * Returns null for messages with no surfaceable text.
   */
  private parseMessage(rawMsg: unknown): ConversationMessage | null {
    const msg = asRecord(rawMsg);
    if (!msg) return null;
    const role = (getString(msg, 'sender') === 'human' || getString(msg, 'role') === 'user')
      ? ('user' as const)
      : ('assistant' as const);

    // Handle content blocks (Claude format)
    let text: string;
    const blocks = getArray(msg, 'content');
    if (blocks) {
      text = blocks
        .map(asRecord)
        .filter((b): b is RawRecord => b !== null && b.type === 'text')
        .map((b) => getString(b, 'text') ?? '')
        .join('\n')
        .trim();
    } else {
      text = (getString(msg, 'text') ?? getString(msg, 'content') ?? '').trim();
    }

    // Caption parity: Claude exports carry message-level `attachments`
    // (with extracted_content — text already extracted from images/docs)
    // and `files` arrays; both were never accessed.
    const extras: string[] = [];
    for (const key of ['attachments', 'files'] as const) {
      for (const rawAtt of getArray(msg, key) ?? []) {
        const att = asRecord(rawAtt);
        if (!att) continue;
        const name = getString(att, 'file_name') ?? getString(att, 'name');
        const extracted = getString(att, 'extracted_content');
        if (extracted && extracted.trim()) {
          extras.push(`[Attached: ${name ?? 'file'}] ${extracted.trim().slice(0, 500)}`);
        } else if (name) {
          extras.push(`[Shared file: ${name}]`);
        }
      }
    }
    if (extras.length > 0) text = [text, ...extras].filter(Boolean).join('\n').trim();
    if (!text) return null;

    return {
      role,
      text,
      timestamp: getString(msg, 'created_at') ?? getString(msg, 'timestamp'),
    };
  }

  private parseConversation(rawConv: unknown): UniversalImportItem[] {
    const conv = asRecord(rawConv);
    if (!conv) return [];
    const title = firstString(conv, 'name', 'title') || 'Untitled';
    const messages: ConversationMessage[] = [];

    const chatMessages = getArray(conv, 'chat_messages') ?? getArray(conv, 'messages') ?? [];
    for (const rawMsg of chatMessages) {
      const parsed = this.parseMessage(rawMsg);
      if (parsed) messages.push(parsed);
    }

    if (messages.length === 0) return [];

    return [{
      id: randomUUID(),
      source: 'claude',
      type: 'conversation',
      title,
      content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
      messages,
      timestamp: firstString(conv, 'created_at', 'create_time') ?? new Date().toISOString(),
      metadata: {
        conversationId: firstString(conv, 'uuid', 'id'),
        messageCount: messages.length,
        projectId: getString(conv, 'project_uuid') ?? undefined,
      },
    }];
  }

  private parseProjectDocs(rawProject: unknown): UniversalImportItem[] {
    const project = asRecord(rawProject);
    const docs = project && getArray(project, 'docs');
    if (!project || !docs) return [];
    const out: UniversalImportItem[] = [];
    for (const rawDoc of docs) {
      const doc = asRecord(rawDoc);
      if (!doc) continue;
      const content = getString(doc, 'content') ?? '';
      if (content.length === 0) continue;
      out.push({
        id: randomUUID(),
        source: 'claude',
        type: 'artifact',
        title: firstString(doc, 'filename', 'title') ?? 'Project Document',
        content,
        timestamp: getString(doc, 'created_at')
          ?? getString(project, 'updated_at')
          ?? getString(project, 'created_at')
          ?? new Date().toISOString(),
        metadata: {
          projectName: getString(project, 'name'),
          projectUuid: getString(project, 'uuid'),
          type: 'project_knowledge',
          docUuid: getString(doc, 'uuid'),
          filename: getString(doc, 'filename'),
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

    for (const rawEntry of arr) {
      const entry = asRecord(rawEntry);
      if (!entry) continue;
      const accountUuid = getString(entry, 'account_uuid');

      // conversations_memory — usually a single long string of user-about facts
      const convMem = entry.conversations_memory;
      if (convMem !== undefined && convMem !== null) {
        const content = typeof convMem === 'string' ? convMem : JSON.stringify(convMem);
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
      const projectMemories = asRecord(entry.project_memories);
      if (projectMemories) {
        for (const [projUuid, memValue] of Object.entries(projectMemories)) {
          const content = typeof memValue === 'string' ? memValue : JSON.stringify(memValue);
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

    return out;
  }

  private parseDesignChat(input: unknown): UniversalImportItem[] {
    const dc = asRecord(input);
    if (!dc) return [];
    const messages: ConversationMessage[] = [];
    const msgs = getArray(dc, 'messages') ?? getArray(dc, 'chat_messages') ?? [];

    for (const rawMsg of msgs) {
      const parsed = this.parseMessage(rawMsg);
      if (parsed) messages.push(parsed);
    }

    if (messages.length === 0) return [];

    return [{
      id: randomUUID(),
      source: 'claude',
      type: 'conversation',
      title: getString(dc, 'title') ?? 'Claude Design Chat',
      content: messages.map((m) => `${m.role}: ${m.text}`).join('\n\n'),
      messages,
      timestamp: getString(dc, 'created_at') ?? new Date().toISOString(),
      metadata: {
        designChatUuid: getString(dc, 'uuid'),
        projectUuid: getString(dc, 'project') ?? undefined,
        messageCount: messages.length,
        stream: 'design_chats',
      },
    }];
  }
}

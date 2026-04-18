/**
 * Memory tools — save_memory + recall_memory.
 * The bread and butter: create I-Frames and hybrid-search recall.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getFrameStore,
  getSearch,
  getSessions,
  getWorkspaceMind,
  getWorkspaceManager,
} from '../core/setup.js';
import type { Importance, FrameSource } from '@hive-mind/core';

export function registerMemoryTools(server: McpServer): void {

  // ── save_memory ─────────────────────────────────────────────────
  server.tool(
    'save_memory',
    'Save a memory (fact, decision, preference, context) that persists across conversations. Auto-indexes for semantic search.',
    {
      content: z.string().describe('The memory content to save'),
      importance: z.enum(['critical', 'important', 'normal', 'temporary']).optional()
        .describe('Memory importance level. Defaults to "normal"'),
      source: z.enum(['user_stated', 'tool_verified', 'agent_inferred', 'system']).optional()
        .describe('How this memory was obtained. Defaults to "agent_inferred"'),
      workspace: z.string().optional()
        .describe('Workspace ID to save into. Omit for personal memory'),
    },
    async ({ content, importance, source, workspace }) => {
      const imp = (importance ?? 'normal') as Importance;
      const src = (source ?? 'agent_inferred') as FrameSource;

      // Resolve target mind
      const target = workspace ? getWorkspaceMind(workspace) : null;
      const frameStore = target?.frameStore ?? getFrameStore();
      const sessions = target?.sessions ?? getSessions();
      const search = target?.search ?? getSearch();

      // Group frames into daily sessions (mcp:YYYY-MM-DD)
      const today = new Date().toISOString().slice(0, 10);
      const session = sessions.ensure(`mcp:${today}`, undefined, `MCP session ${today}`);

      // Create the I-Frame (dedup is built into FrameStore)
      const frame = frameStore.createIFrame(session.gop_id, content, imp, src);

      // Index in vector store for semantic search
      try {
        await search.indexFrame(frame.id, content);
      } catch {
        // Vector indexing failure is non-fatal — FTS still works
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: frame.id,
            content: frame.content,
            importance: frame.importance,
            source: frame.source,
            created_at: frame.created_at,
            workspace: workspace ?? 'personal',
          }, null, 2),
        }],
      };
    },
  );

  // ── recall_memory ───────────────────────────────────────────────
  server.tool(
    'recall_memory',
    'Search memories using semantic hybrid search (keyword + vector). Returns ranked results from personal and/or workspace memories.',
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().min(1).max(100).optional()
        .describe('Maximum results to return. Defaults to 10'),
      workspace: z.string().optional()
        .describe('Workspace ID to search. Omit to search personal memory'),
      scope: z.enum(['current', 'personal', 'all']).optional()
        .describe('"current" = active workspace only, "personal" = personal mind only, "all" = search everything. Defaults to "personal"'),
      profile: z.enum(['balanced', 'recent', 'important', 'connected']).optional()
        .describe('Scoring profile for ranking results. Defaults to "balanced"'),
    },
    async ({ query, limit, workspace, scope, profile }) => {
      const maxResults = limit ?? 10;
      const scoringProfile = profile ?? 'balanced';
      const searchScope = scope ?? 'personal';

      interface ResultItem {
        id: number;
        content: string;
        importance: string;
        source: string;
        score: number;
        created_at: string;
        from: string;
      }
      const results: ResultItem[] = [];

      const searchOpts = {
        limit: maxResults,
        profile: scoringProfile as 'balanced' | 'recent' | 'important' | 'connected',
      };

      // Search personal mind
      if (searchScope === 'personal' || searchScope === 'all') {
        const search = getSearch();
        const personalResults = await search.search(query, searchOpts);
        for (const r of personalResults) {
          results.push({
            id: r.frame.id,
            content: r.frame.content,
            importance: r.frame.importance,
            source: r.frame.source,
            score: Math.round(r.finalScore * 1000) / 1000,
            created_at: r.frame.created_at,
            from: 'personal',
          });
        }
      }

      // Search specific workspace
      if (searchScope === 'current' && workspace) {
        const wsMind = getWorkspaceMind(workspace);
        if (wsMind) {
          const wsResults = await wsMind.search.search(query, searchOpts);
          for (const r of wsResults) {
            results.push({
              id: r.frame.id,
              content: r.frame.content,
              importance: r.frame.importance,
              source: r.frame.source,
              score: Math.round(r.finalScore * 1000) / 1000,
              created_at: r.frame.created_at,
              from: `workspace:${workspace}`,
            });
          }
        }
      }

      // Search ALL workspaces when scope is 'all'
      if (searchScope === 'all') {
        const wm = getWorkspaceManager();
        const allWorkspaces = wm.list();
        for (const ws of allWorkspaces) {
          const wsMind = getWorkspaceMind(ws.id);
          if (!wsMind) continue;
          try {
            const wsResults = await wsMind.search.search(query, searchOpts);
            for (const r of wsResults) {
              results.push({
                id: r.frame.id,
                content: r.frame.content,
                importance: r.frame.importance,
                source: r.frame.source,
                score: Math.round(r.finalScore * 1000) / 1000,
                created_at: r.frame.created_at,
                from: `workspace:${ws.id}`,
              });
            }
          } catch { /* workspace search failure is non-fatal */ }
        }
      }

      // Sort all results by score descending and trim
      results.sort((a, b) => b.score - a.score);
      const trimmed = results.slice(0, maxResults);

      if (trimmed.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No memories found for query: "${query}"`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(trimmed, null, 2),
        }],
      };
    },
  );
}

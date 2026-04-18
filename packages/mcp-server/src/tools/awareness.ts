/**
 * Awareness tools — get_awareness + set_awareness + clear_awareness.
 * Wraps AwarenessLayer from @hive-mind/core.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAwareness } from '../core/setup.js';
import type { AwarenessCategory } from '@hive-mind/core';

export function registerAwarenessTools(server: McpServer): void {

  // ── get_awareness ───────────────────────────────────────────────
  server.tool(
    'get_awareness',
    'Get current awareness items — active tasks, pending actions, context flags. These are short-lived context items that help the AI maintain situational awareness.',
    {
      category: z.enum(['task', 'action', 'pending', 'flag']).optional()
        .describe('Filter by category. Omit to get all'),
    },
    async ({ category }) => {
      const awareness = getAwareness();

      const items = category
        ? awareness.getByCategory(category as AwarenessCategory)
        : awareness.getAll();

      if (items.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No active awareness items.',
          }],
        };
      }

      const formatted = items.map(item => ({
        id: item.id,
        category: item.category,
        content: item.content,
        priority: item.priority,
        expires_at: item.expires_at,
        created_at: item.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(formatted, null, 2),
        }],
      };
    },
  );

  // ── set_awareness ───────────────────────────────────────────────
  server.tool(
    'set_awareness',
    'Set an awareness item — a short-lived context marker for active tasks, pending actions, or flags. Items can auto-expire.',
    {
      category: z.enum(['task', 'action', 'pending', 'flag'])
        .describe('Item category: task (active work), action (recent action), pending (waiting), flag (context note)'),
      content: z.string().describe('The awareness content'),
      priority: z.number().min(0).max(10).optional()
        .describe('Priority 0-10, higher = more important. Defaults to 0'),
      ttl_minutes: z.number().min(1).optional()
        .describe('Time-to-live in minutes. Item auto-expires after this duration'),
    },
    async ({ category, content, priority, ttl_minutes }) => {
      const awareness = getAwareness();

      let expiresAt: string | undefined;
      if (ttl_minutes) {
        const expiry = new Date(Date.now() + ttl_minutes * 60_000);
        expiresAt = expiry.toISOString();
      }

      const item = awareness.add(
        category as AwarenessCategory,
        content,
        priority ?? 0,
        expiresAt,
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: item.id,
            category: item.category,
            content: item.content,
            priority: item.priority,
            expires_at: item.expires_at,
          }, null, 2),
        }],
      };
    },
  );

  // ── clear_awareness ─────────────────────────────────────────────
  server.tool(
    'clear_awareness',
    'Remove an awareness item by ID, or clear all items in a category.',
    {
      id: z.number().optional().describe('Specific item ID to remove'),
      category: z.enum(['task', 'action', 'pending', 'flag']).optional()
        .describe('Clear all items in this category'),
    },
    async ({ id, category }) => {
      const awareness = getAwareness();

      if (id !== undefined) {
        awareness.remove(id);
        return {
          content: [{
            type: 'text' as const,
            text: `Removed awareness item #${id}`,
          }],
        };
      }

      if (category) {
        awareness.clearCategory(category as AwarenessCategory);
        return {
          content: [{
            type: 'text' as const,
            text: `Cleared all "${category}" awareness items`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: 'Provide either an id or category to clear.',
        }],
      };
    },
  );
}

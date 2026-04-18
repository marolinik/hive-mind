/**
 * Identity tools — get_identity + set_identity.
 * Wraps IdentityLayer from @hive-mind/core.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getIdentity } from '../core/setup.js';

export function registerIdentityTools(server: McpServer): void {

  // ── get_identity ────────────────────────────────────────────────
  server.tool(
    'get_identity',
    'Get the user\'s identity profile — name, role, department, personality, capabilities. Returns the persistent identity stored in the personal mind.',
    {},
    async () => {
      const identity = getIdentity();

      if (!identity.exists()) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              configured: false,
              message: 'No identity configured yet. Use set_identity to create one.',
            }, null, 2),
          }],
        };
      }

      const id = identity.get();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            configured: true,
            name: id.name,
            role: id.role,
            department: id.department,
            personality: id.personality,
            capabilities: id.capabilities,
            system_prompt: id.system_prompt,
            updated_at: id.updated_at,
          }, null, 2),
        }],
      };
    },
  );

  // ── set_identity ────────────────────────────────────────────────
  server.tool(
    'set_identity',
    'Create or update the user\'s identity profile. Only provided fields are updated; omitted fields are preserved.',
    {
      name: z.string().optional().describe('User\'s name'),
      role: z.string().optional().describe('Professional role (e.g., "Senior Engineer", "Product Manager")'),
      department: z.string().optional().describe('Department or team'),
      personality: z.string().optional().describe('Communication style preferences'),
      capabilities: z.string().optional().describe('Technical capabilities and expertise areas'),
      system_prompt: z.string().optional().describe('Custom system prompt additions'),
    },
    async ({ name, role, department, personality, capabilities, system_prompt }) => {
      const identity = getIdentity();

      if (!identity.exists()) {
        // Create new identity — require at least a name
        const id = identity.create({
          name: name ?? 'User',
          role: role ?? '',
          department: department ?? '',
          personality: personality ?? '',
          capabilities: capabilities ?? '',
          system_prompt: system_prompt ?? '',
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'created',
              name: id.name,
              role: id.role,
              department: id.department,
            }, null, 2),
          }],
        };
      }

      // Update existing identity — only set provided fields
      const updates: Record<string, string> = {};
      if (name !== undefined) updates.name = name;
      if (role !== undefined) updates.role = role;
      if (department !== undefined) updates.department = department;
      if (personality !== undefined) updates.personality = personality;
      if (capabilities !== undefined) updates.capabilities = capabilities;
      if (system_prompt !== undefined) updates.system_prompt = system_prompt;

      if (Object.keys(updates).length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No fields provided to update.',
          }],
        };
      }

      const id = identity.update(updates);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            action: 'updated',
            name: id.name,
            role: id.role,
            department: id.department,
            updated_at: id.updated_at,
          }, null, 2),
        }],
      };
    },
  );
}

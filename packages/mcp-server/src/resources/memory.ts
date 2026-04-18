/**
 * MCP Resource handlers — expose memory state as readable resources.
 *
 * Resources:
 *   memory://personal/stats   → frame count, entity count, embedding status
 *   memory://workspace/{id}   → workspace info + memory stats
 *   memory://identity         → current identity profile
 *   memory://awareness        → current awareness items
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getFrameStore,
  getKnowledgeGraph,
  getIdentity,
  getAwareness,
  getEmbedder,
  getWorkspaceManager,
  getWorkspaceMind,
} from '../core/setup.js';

export function registerResources(server: McpServer): void {

  // ── memory://personal/stats ─────────────────────────────────────
  server.resource(
    'personal-stats',
    'memory://personal/stats',
    async (uri) => {
      const frameStore = getFrameStore();
      const kg = getKnowledgeGraph();
      const embedder = getEmbedder();

      const stats = frameStore.getStats();
      const entityCount = kg.getEntityCount();
      const entityTypes = kg.getEntityTypeCounts();
      const embeddingStatus = embedder.getStatus();

      const data = {
        uri: uri.href,
        frames: {
          total: stats.total,
          by_type: stats.byType,
          by_importance: stats.byImportance,
        },
        knowledge_graph: {
          entities: entityCount,
          entity_types: entityTypes,
        },
        embedding: {
          provider: embeddingStatus.activeProvider,
          model: embeddingStatus.modelName,
          dimensions: embeddingStatus.dimensions,
          available_providers: embeddingStatus.availableProviders,
        },
      };

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      };
    },
  );

  // ── memory://identity ───────────────────────────────────────────
  server.resource(
    'identity',
    'memory://identity',
    async (uri) => {
      const identity = getIdentity();

      let data: Record<string, unknown>;
      if (!identity.exists()) {
        data = { configured: false };
      } else {
        const id = identity.get();
        data = {
          configured: true,
          name: id.name,
          role: id.role,
          department: id.department,
          personality: id.personality,
          capabilities: id.capabilities,
        };
      }

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      };
    },
  );

  // ── memory://awareness ──────────────────────────────────────────
  server.resource(
    'awareness',
    'memory://awareness',
    async (uri) => {
      const awareness = getAwareness();
      const items = awareness.getAll();

      const data = items.map(item => ({
        id: item.id,
        category: item.category,
        content: item.content,
        priority: item.priority,
        expires_at: item.expires_at,
        created_at: item.created_at,
      }));

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      };
    },
  );

  // ── memory://workspace/{id} (resource template) ─────────────────
  server.resource(
    'workspace',
    'memory://workspace/{id}',
    async (uri) => {
      // Extract workspace ID from URI
      const match = uri.href.match(/memory:\/\/workspace\/(.+)/);
      const workspaceId = match?.[1];

      if (!workspaceId) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Invalid workspace URI' }),
          }],
        };
      }

      const wm = getWorkspaceManager();
      const config = wm.get(workspaceId);

      if (!config) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: `Workspace not found: ${workspaceId}` }),
          }],
        };
      }

      // Get workspace mind stats
      let stats = { frames: 0, entities: 0 };
      try {
        const mind = getWorkspaceMind(workspaceId);
        if (mind) {
          const fs = mind.frameStore.getStats();
          stats = { frames: fs.total, entities: mind.knowledgeGraph.getEntityCount() };
        }
      } catch { /* workspace mind not accessible */ }

      const data = {
        id: config.id,
        name: config.name,
        group: config.group,
        icon: config.icon ?? null,
        model: config.model ?? null,
        created: config.created,
        frames: stats.frames,
        entities: stats.entities,
      };

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      };
    },
  );
}

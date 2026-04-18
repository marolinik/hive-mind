/**
 * Knowledge graph tools — search_entities + save_entity + create_relation.
 * Wraps KnowledgeGraph from @hive-mind/core.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getKnowledgeGraph, getWorkspaceMind } from '../core/setup.js';

const ENTITY_TYPES = [
  'person', 'project', 'concept', 'organization',
  'technology', 'tool', 'location', 'event',
] as const;

export function registerKnowledgeTools(server: McpServer): void {

  // ── search_entities ─────────────────────────────────────────────
  server.tool(
    'search_entities',
    'Search the knowledge graph for entities (people, projects, concepts, organizations, technologies). Returns matching entities with their relations.',
    {
      query: z.string().describe('Search query — matches entity names'),
      type: z.enum(ENTITY_TYPES).optional()
        .describe('Filter by entity type'),
      limit: z.number().min(1).max(200).optional()
        .describe('Maximum results. Defaults to 20'),
      workspace: z.string().optional()
        .describe('Workspace ID. Omit for personal knowledge graph'),
    },
    async ({ query, type, limit, workspace }) => {
      const maxResults = limit ?? 20;
      const target = workspace ? getWorkspaceMind(workspace) : null;
      const kg = target?.knowledgeGraph ?? getKnowledgeGraph();

      // If type filter provided, search within that type
      let entities;
      if (type) {
        const typed = kg.getEntitiesByType(type, maxResults * 2);
        entities = typed.filter(e =>
          e.name.toLowerCase().includes(query.toLowerCase())
        ).slice(0, maxResults);
      } else {
        entities = kg.searchEntities(query, maxResults);
      }

      // Enrich with relations for each entity
      const enriched = entities.map(e => {
        const relationsFrom = kg.getRelationsFrom(e.id);
        const relationsTo = kg.getRelationsTo(e.id);
        return {
          id: e.id,
          type: e.entity_type,
          name: e.name,
          properties: safeParseJson(e.properties),
          valid_from: e.valid_from,
          valid_to: e.valid_to,
          relations: {
            outgoing: relationsFrom.map(r => ({
              target_id: r.target_id,
              type: r.relation_type,
              confidence: r.confidence,
            })),
            incoming: relationsTo.map(r => ({
              source_id: r.source_id,
              type: r.relation_type,
              confidence: r.confidence,
            })),
          },
        };
      });

      if (enriched.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No entities found matching "${query}"`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(enriched, null, 2),
        }],
      };
    },
  );

  // ── save_entity ─────────────────────────────────────────────────
  server.tool(
    'save_entity',
    'Create or update an entity in the knowledge graph. Auto-deduplicates by normalized name.',
    {
      type: z.enum(ENTITY_TYPES).describe('Entity type'),
      name: z.string().describe('Entity name (e.g., "John Smith", "Project Alpha")'),
      properties: z.record(z.unknown()).optional()
        .describe('Key-value properties for the entity'),
      workspace: z.string().optional()
        .describe('Workspace ID. Omit for personal knowledge graph'),
    },
    async ({ type, name, properties, workspace }) => {
      const target = workspace ? getWorkspaceMind(workspace) : null;
      const kg = target?.knowledgeGraph ?? getKnowledgeGraph();
      const props = properties ?? {};

      // Check for existing entity with same name and type (dedup)
      const existing = kg.searchEntities(name, 10)
        .find(e =>
          e.entity_type === type &&
          e.name.toLowerCase() === name.toLowerCase()
        );

      let entity;
      if (existing) {
        // Merge properties into existing entity
        const existingProps = safeParseJson(existing.properties);
        const merged = { ...existingProps, ...props };
        entity = kg.updateEntity(existing.id, { properties: merged });
      } else {
        entity = kg.createEntity(type, name, props);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: entity.id,
            type: entity.entity_type,
            name: entity.name,
            properties: safeParseJson(entity.properties),
            created: !existing,
            updated: !!existing,
          }, null, 2),
        }],
      };
    },
  );

  // ── create_relation ──────────────────────────────────────────────
  server.tool(
    'create_relation',
    'Create a relationship between two entities in the knowledge graph.',
    {
      source_id: z.number().describe('Source entity ID'),
      target_id: z.number().describe('Target entity ID'),
      relation_type: z.string().describe('Relationship type (e.g., "works_on", "knows", "uses")'),
      confidence: z.number().min(0).max(1).optional()
        .describe('Confidence score 0-1. Defaults to 1.0'),
      properties: z.record(z.unknown()).optional()
        .describe('Additional relation properties'),
      workspace: z.string().optional()
        .describe('Workspace ID. Omit for personal knowledge graph'),
    },
    async ({ source_id, target_id, relation_type, confidence, properties, workspace }) => {
      const target = workspace ? getWorkspaceMind(workspace) : null;
      const kg = target?.knowledgeGraph ?? getKnowledgeGraph();

      const relation = kg.createRelation(
        source_id,
        target_id,
        relation_type,
        confidence ?? 1.0,
        properties ?? {},
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: relation.id,
            source_id: relation.source_id,
            target_id: relation.target_id,
            type: relation.relation_type,
            confidence: relation.confidence,
          }, null, 2),
        }],
      };
    },
  );
}

function safeParseJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { return {}; }
}

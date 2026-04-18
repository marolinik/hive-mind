/**
 * Cleanup tools — data maintenance for the memory system.
 *
 * cleanup_frames:   Wipe test pollution, compact stale frames, reconcile indexes.
 * cleanup_entities: Delete misclassified KG entities, dedup, retire orphans.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getPersonalDb,
  getFrameStore,
  getKnowledgeGraph,
  getEmbedder,
  getWorkspaceMind,
} from '../core/setup.js';
import {
  reconcileIndexes,
  normalizeEntityName,
} from '@hive-mind/core';

// Common nouns that get misclassified as person/project entities
const NOISE_ENTITY_NAMES = new Set([
  'begin week', 'end week', 'begin day', 'end day',
  'test', 'testing', 'tests', 'todo', 'todos', 'fix', 'bug',
  'error', 'warning', 'success', 'failure', 'result', 'results',
  'start', 'stop', 'begin', 'end', 'run', 'running',
  'true', 'false', 'null', 'undefined', 'none',
  'yes', 'no', 'ok', 'okay',
  'step 1', 'step 2', 'step 3', 'step 4', 'step 5',
  'phase 1', 'phase 2', 'phase 3', 'phase 4',
  'part 1', 'part 2', 'part 3',
  'item', 'items', 'thing', 'things', 'stuff',
  'data', 'file', 'files', 'folder', 'path',
  'input', 'output', 'response', 'request',
  'user', 'admin', 'system', 'server', 'client',
  'the', 'a', 'an', 'this', 'that',
]);

function isNoiseEntity(name: string, entityType: string): boolean {
  const lower = name.toLowerCase().trim();

  // Very short names are usually noise
  if (lower.length <= 2) return true;

  // Check the noise list
  if (NOISE_ENTITY_NAMES.has(lower)) return true;

  // Single character or number-only names
  if (/^\d+$/.test(lower)) return true;

  // Common nouns misclassified as person
  if (entityType === 'person') {
    // Names that are clearly not people
    if (/^(step|phase|part|section|item|task|bug|fix|test)\b/i.test(lower)) return true;
    // Names that are too generic
    if (/^(the|a|an|this|that|my|your)\s/i.test(lower)) return true;
  }

  return false;
}

export function registerCleanupTools(server: McpServer): void {

  // ── cleanup_frames ─────────────────────────────────────────────
  server.tool(
    'cleanup_frames',
    'Maintenance tool: compact stale frames, remove test pollution, and reconcile search indexes. Use with mode="compact" for routine maintenance, or mode="wipe_imports" to remove all imported frames (e.g., E2E test data).',
    {
      mode: z.enum(['compact', 'wipe_imports', 'wipe_all', 'reconcile'])
        .describe('compact: prune old temp/deprecated + merge P-frames. wipe_imports: delete all source=import frames. wipe_all: delete ALL frames (DANGER). reconcile: repair FTS/vector indexes.'),
      workspace: z.string().optional()
        .describe('Workspace ID. Omit for personal mind.'),
      max_temp_age_days: z.number().optional()
        .describe('For compact mode: delete temporary frames older than N days (default 30)'),
      max_deprecated_age_days: z.number().optional()
        .describe('For compact mode: delete deprecated frames older than N days (default 90)'),
    },
    async ({ mode, workspace, max_temp_age_days, max_deprecated_age_days }) => {
      const db = workspace
        ? getWorkspaceMind(workspace)?.db ?? null
        : getPersonalDb();

      if (!db) {
        return {
          content: [{ type: 'text' as const, text: `Workspace "${workspace}" not found.` }],
          isError: true,
        };
      }

      const frameStore = workspace
        ? getWorkspaceMind(workspace)!.frameStore
        : getFrameStore();
      const raw = db.getDatabase();

      if (mode === 'compact') {
        const result = frameStore.compact(
          max_temp_age_days ?? 30,
          max_deprecated_age_days ?? 90,
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'compact',
              temporary_pruned: result.temporaryPruned,
              deprecated_pruned: result.deprecatedPruned,
              pframes_merged: result.pframesMerged,
            }, null, 2),
          }],
        };
      }

      if (mode === 'wipe_imports') {
        // Delete all frames with source='import'
        const countRow = raw.prepare(
          "SELECT COUNT(*) as cnt FROM memory_frames WHERE source = 'import'",
        ).get() as { cnt: number };

        if (countRow.cnt === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No imported frames found.' }],
          };
        }

        // Get IDs for cascade cleanup
        const frameIds = raw.prepare(
          "SELECT id FROM memory_frames WHERE source = 'import'",
        ).all() as { id: number }[];

        const deleteTx = raw.transaction(() => {
          for (const { id } of frameIds) {
            // Clean FTS
            raw.prepare('DELETE FROM memory_frames_fts WHERE rowid = ?').run(id);
            // Clean vector
            try { raw.prepare('DELETE FROM memory_frames_vec WHERE rowid = ?').run(id); } catch { /* ok */ }
          }
          // Bulk delete frames
          raw.prepare("DELETE FROM memory_frames WHERE source = 'import'").run();
        });
        deleteTx();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'wipe_imports',
              frames_deleted: countRow.cnt,
            }, null, 2),
          }],
        };
      }

      if (mode === 'wipe_all') {
        const stats = frameStore.getStats();

        const deleteTx = raw.transaction(() => {
          raw.prepare('DELETE FROM memory_frames_fts').run();
          try { raw.prepare('DELETE FROM memory_frames_vec').run(); } catch { /* ok */ }
          raw.prepare('DELETE FROM memory_frames').run();
          raw.prepare('DELETE FROM sessions').run();
        });
        deleteTx();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'wipe_all',
              frames_deleted: stats.total,
              warning: 'ALL frames and sessions deleted. This cannot be undone.',
            }, null, 2),
          }],
        };
      }

      if (mode === 'reconcile') {
        const result = await reconcileIndexes(db, getEmbedder());
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'reconcile',
              fts_fixed: result.ftsFixed,
              vec_fixed: result.vecFixed,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Unknown mode: ${mode}` }],
        isError: true,
      };
    },
  );

  // ── cleanup_entities ───────────────────────────────────────────
  server.tool(
    'cleanup_entities',
    'Maintenance tool: remove noise entities from the knowledge graph, deduplicate by normalized name, and retire orphan entities with no relations.',
    {
      mode: z.enum(['audit', 'remove_noise', 'dedup', 'retire_orphans', 'wipe_all'])
        .describe('audit: report noise + duplicates without deleting. remove_noise: delete misclassified entities. dedup: merge duplicate entities. retire_orphans: soft-delete entities with 0 relations. wipe_all: delete ALL entities and relations.'),
      workspace: z.string().optional()
        .describe('Workspace ID. Omit for personal mind.'),
    },
    async ({ mode, workspace }) => {
      const kg = workspace
        ? getWorkspaceMind(workspace)?.knowledgeGraph ?? null
        : getKnowledgeGraph();
      const db = workspace
        ? getWorkspaceMind(workspace)?.db ?? null
        : getPersonalDb();

      if (!kg || !db) {
        return {
          content: [{ type: 'text' as const, text: `Workspace "${workspace}" not found.` }],
          isError: true,
        };
      }

      const raw = db.getDatabase();

      if (mode === 'audit') {
        // Count noise entities
        const allEntities = kg.getEntities(10000);
        const noiseEntities = allEntities.filter(e => isNoiseEntity(e.name, e.entity_type));

        // Find duplicates
        const normalizedGroups = new Map<string, typeof allEntities>();
        for (const entity of allEntities) {
          const key = `${normalizeEntityName(entity.name)}::${entity.entity_type.toLowerCase()}`;
          let group = normalizedGroups.get(key);
          if (!group) {
            group = [];
            normalizedGroups.set(key, group);
          }
          group.push(entity);
        }
        const duplicateGroups = Array.from(normalizedGroups.values()).filter(g => g.length > 1);

        // Count orphans (entities with no relations)
        const orphanCount = raw.prepare(`
          SELECT COUNT(*) as cnt FROM knowledge_entities e
          WHERE e.valid_to IS NULL
            AND e.id NOT IN (SELECT source_id FROM knowledge_relations WHERE valid_to IS NULL)
            AND e.id NOT IN (SELECT target_id FROM knowledge_relations WHERE valid_to IS NULL)
        `).get() as { cnt: number };

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'audit',
              total_entities: allEntities.length,
              noise_entities: noiseEntities.length,
              noise_sample: noiseEntities.slice(0, 20).map(e => ({ id: e.id, name: e.name, type: e.entity_type })),
              duplicate_groups: duplicateGroups.length,
              duplicate_sample: duplicateGroups.slice(0, 10).map(g => g.map(e => ({ id: e.id, name: e.name, type: e.entity_type }))),
              orphan_entities: orphanCount.cnt,
            }, null, 2),
          }],
        };
      }

      if (mode === 'remove_noise') {
        const allEntities = kg.getEntities(10000);
        const noiseEntities = allEntities.filter(e => isNoiseEntity(e.name, e.entity_type));

        let removed = 0;
        const removeTx = raw.transaction(() => {
          for (const entity of noiseEntities) {
            // Retire relations first
            const rels = [
              ...kg.getRelationsFrom(entity.id),
              ...kg.getRelationsTo(entity.id),
            ];
            for (const rel of rels) {
              kg.retireRelation(rel.id);
            }
            kg.retireEntity(entity.id);
            removed++;
          }
        });
        removeTx();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'remove_noise',
              entities_retired: removed,
            }, null, 2),
          }],
        };
      }

      if (mode === 'dedup') {
        const allEntities = kg.getEntities(10000);
        const normalizedGroups = new Map<string, typeof allEntities>();
        for (const entity of allEntities) {
          const key = `${normalizeEntityName(entity.name)}::${entity.entity_type.toLowerCase()}`;
          let group = normalizedGroups.get(key);
          if (!group) {
            group = [];
            normalizedGroups.set(key, group);
          }
          group.push(entity);
        }

        let merged = 0;
        const dedupTx = raw.transaction(() => {
          for (const group of normalizedGroups.values()) {
            if (group.length <= 1) continue;

            // Keep the entity with the most relations (or the oldest)
            const sorted = group.sort((a, b) => {
              const aRels = kg.getRelationsFrom(a.id).length + kg.getRelationsTo(a.id).length;
              const bRels = kg.getRelationsFrom(b.id).length + kg.getRelationsTo(b.id).length;
              return bRels - aRels;
            });
            const keep = sorted[0];
            const retire = sorted.slice(1);

            for (const dup of retire) {
              // Re-point relations from dup to keep
              for (const rel of kg.getRelationsFrom(dup.id)) {
                try {
                  kg.createRelation(keep.id, rel.target_id, rel.relation_type, rel.confidence);
                } catch { /* may already exist */ }
                kg.retireRelation(rel.id);
              }
              for (const rel of kg.getRelationsTo(dup.id)) {
                try {
                  kg.createRelation(rel.source_id, keep.id, rel.relation_type, rel.confidence);
                } catch { /* may already exist */ }
                kg.retireRelation(rel.id);
              }

              // Merge properties
              try {
                const keepProps = JSON.parse(keep.properties || '{}');
                const dupProps = JSON.parse(dup.properties || '{}');
                const mergedProps = { ...dupProps, ...keepProps };
                kg.updateEntity(keep.id, { properties: mergedProps });
              } catch { /* ok */ }

              kg.retireEntity(dup.id);
              merged++;
            }
          }
        });
        dedupTx();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'dedup',
              entities_merged: merged,
            }, null, 2),
          }],
        };
      }

      if (mode === 'retire_orphans') {
        const orphans = raw.prepare(`
          SELECT id FROM knowledge_entities e
          WHERE e.valid_to IS NULL
            AND e.id NOT IN (SELECT source_id FROM knowledge_relations WHERE valid_to IS NULL)
            AND e.id NOT IN (SELECT target_id FROM knowledge_relations WHERE valid_to IS NULL)
        `).all() as { id: number }[];

        let retired = 0;
        const retireTx = raw.transaction(() => {
          for (const { id } of orphans) {
            kg.retireEntity(id);
            retired++;
          }
        });
        retireTx();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'retire_orphans',
              entities_retired: retired,
            }, null, 2),
          }],
        };
      }

      if (mode === 'wipe_all') {
        const entityCount = kg.getEntityCount();

        const wipeTx = raw.transaction(() => {
          raw.prepare("UPDATE knowledge_relations SET valid_to = datetime('now') WHERE valid_to IS NULL").run();
          raw.prepare("UPDATE knowledge_entities SET valid_to = datetime('now') WHERE valid_to IS NULL").run();
        });
        wipeTx();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action: 'wipe_all',
              entities_retired: entityCount,
              warning: 'ALL entities and relations soft-deleted. This cannot be undone.',
            }, null, 2),
          }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Unknown mode: ${mode}` }],
        isError: true,
      };
    },
  );
}

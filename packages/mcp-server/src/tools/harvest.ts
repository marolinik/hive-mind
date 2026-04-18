/**
 * Harvest tools — harvest_import + harvest_sources.
 * Import conversations from ChatGPT, Claude, Gemini, and other AI systems.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import {
  getFrameStore,
  getSessions,
  getSearch,
  getKnowledgeGraph,
  getHarvestSourceStore,
  getPersonalDb,
  getAdapter,
} from '../core/setup.js';

export function registerHarvestTools(server: McpServer): void {

  // ── harvest_import ──────────────────────────────────────────────
  server.tool(
    'harvest_import',
    'Import conversation history from external AI systems (ChatGPT, Claude, Gemini, etc.). Parses the export data and saves extracted memories to the personal mind.',
    {
      source: z.enum([
        'chatgpt', 'claude', 'claude-code', 'gemini', 'universal',
      ]).describe('Source AI system'),
      data: z.string().optional()
        .describe('JSON string of the export data. Provide this OR file_path, not both'),
      file_path: z.string().optional()
        .describe('Path to the export file on disk. Provide this OR data, not both'),
    },
    async ({ source, data, file_path }) => {
      // Validate: one of data or file_path must be provided
      if (!data && !file_path) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: provide either "data" (JSON string) or "file_path" (path to export file)',
          }],
          isError: true,
        };
      }

      // Parse input
      let parsed: unknown;
      try {
        if (file_path) {
          const raw = fs.readFileSync(file_path, 'utf-8');
          parsed = JSON.parse(raw);
        } else {
          parsed = JSON.parse(data!);
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error parsing input: ${err instanceof Error ? err.message : 'invalid JSON'}`,
          }],
          isError: true,
        };
      }

      // Get the appropriate adapter
      const adapter = getAdapter(source);
      const items = adapter.parse(parsed);

      if (items.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No conversations found in ${source} export data.`,
          }],
        };
      }

      // Save each item as an I-Frame in the personal mind
      const frameStore = getFrameStore();
      const sessions = getSessions();
      const search = getSearch();
      const kg = getKnowledgeGraph();
      const harvestStore = getHarvestSourceStore();

      // Ensure a persistent harvest session
      const session = sessions.ensure(
        `harvest:${source}`,
        undefined,
        `Harvest import from ${source}`,
      );

      let framesCreated = 0;
      let duplicatesSkipped = 0;
      let entitiesCreated = 0;

      // Record max frame id before the batch. createIFrame dedups by content,
      // so a "not new" frame returns an older id. id-based detection is
      // format-agnostic; comparing timestamps here would trip on the mismatch
      // between JS's ISO format and SQLite's space-separated datetime('now').
      const rawDb = getPersonalDb().getDatabase();
      const maxBefore =
        (rawDb.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM memory_frames').get() as { m: number }).m;

      for (const item of items) {
        // Build a summary from the conversation
        const content = item.title
          ? `[${item.source}] ${item.title}: ${item.content.slice(0, 2000)}`
          : `[${item.source}] ${item.content.slice(0, 2000)}`;

        // createIFrame handles dedup internally — returns existing frame if content matches
        const frame = frameStore.createIFrame(
          session.gop_id,
          content,
          'normal',
          'import',
        );

        // Frames created during this batch have id > maxBefore.
        // Dedup hits return the original frame whose id is older.
        const isNew = frame.id > maxBefore;

        if (isNew) {
          framesCreated++;

          // Index for semantic search (non-fatal)
          try {
            await search.indexFrame(frame.id, content);
          } catch { /* vector indexing failure is non-fatal */ }

          // Extract basic entities from metadata if present
          if (item.metadata?.entities && Array.isArray(item.metadata.entities)) {
            for (const ent of item.metadata.entities as { name: string; type: string }[]) {
              try {
                kg.createEntity(ent.type || 'concept', ent.name, {
                  source: item.source,
                  imported_from: item.title,
                });
                entitiesCreated++;
              } catch { /* entity creation failure is non-fatal */ }
            }
          }
        } else {
          duplicatesSkipped++;
        }
      }

      // Record the sync in harvest source store
      harvestStore.upsert(
        source as Parameters<typeof harvestStore.upsert>[0],
        adapter.displayName,
        file_path ?? undefined,
      );
      harvestStore.recordSync(
        source as Parameters<typeof harvestStore.recordSync>[0],
        items.length,
        framesCreated,
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            source,
            items_found: items.length,
            frames_created: framesCreated,
            duplicates_skipped: duplicatesSkipped,
            entities_created: entitiesCreated,
          }, null, 2),
        }],
      };
    },
  );

  // ── harvest_sources ─────────────────────────────────────────────
  server.tool(
    'harvest_sources',
    'List all registered harvest sources and their sync status.',
    {},
    async () => {
      const store = getHarvestSourceStore();
      const sources = store.getAll();

      if (sources.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No harvest sources registered yet. Use harvest_import to import conversation data.',
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(sources.map(s => ({
            source: s.source,
            display_name: s.displayName,
            last_synced: s.lastSyncedAt,
            items_imported: s.itemsImported,
            frames_created: s.framesCreated,
            auto_sync: s.autoSync,
          })), null, 2),
        }],
      };
    },
  );
}

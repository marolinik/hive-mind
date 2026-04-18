/**
 * Ingest tools — import documents, URLs, and files into the memory system.
 *
 * ingest_source: Universal ingestion tool that auto-detects content type
 * and routes through the appropriate adapter.
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
import { UrlAdapter } from '@hive-mind/core';
import type { PdfAdapter } from '@hive-mind/core';
import type { UniversalImportItem } from '@hive-mind/core';

export function registerIngestTools(server: McpServer): void {

  // ── ingest_source ──────────────────────────────────────────────
  server.tool(
    'ingest_source',
    'Ingest a document, URL, or text into the memory system. Auto-detects content type or use type_hint. Supports: markdown files, plain text, PDF files, web URLs, and raw text content.',
    {
      content: z.string()
        .describe('Content to ingest: a file path, URL, or raw text/markdown content'),
      type_hint: z.enum(['markdown', 'plaintext', 'pdf', 'url', 'auto']).default('auto')
        .describe('Content type hint. "auto" detects from content (default)'),
      importance: z.enum(['critical', 'important', 'normal']).default('normal')
        .describe('Importance level for stored frames'),
      tags: z.array(z.string()).optional()
        .describe('Optional tags to attach as metadata'),
      workspace: z.string().optional()
        .describe('Workspace ID. Omit for personal mind'),
    },
    async ({ content, type_hint, importance, tags }) => {
      // Detect content type
      const detectedType = type_hint === 'auto'
        ? detectContentType(content)
        : type_hint;

      let items: UniversalImportItem[];

      try {
        if (detectedType === 'url') {
          // URL requires async fetch
          const urlAdapter = new UrlAdapter();
          items = await urlAdapter.fetchAndParse(content);
        } else if (detectedType === 'pdf') {
          // PDF requires async parse
          const { PdfAdapter: PdfAdapterClass } = await import('@hive-mind/core');
          const pdfAdapter = new PdfAdapterClass() as PdfAdapter;
          items = await pdfAdapter.parseFile(content);
        } else {
          // Markdown, plaintext, or raw text — synchronous
          const adapter = getAdapter(detectedType);
          items = adapter.parse(content);
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error processing ${detectedType} content: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }

      if (items.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No content extracted from ${detectedType} input.`,
          }],
        };
      }

      // Store items as frames
      const frameStore = getFrameStore();
      const sessions = getSessions();
      const search = getSearch();
      const kg = getKnowledgeGraph();
      const harvestStore = getHarvestSourceStore();

      const sessionId = `ingest:${detectedType}:${new Date().toISOString().slice(0, 10)}`;
      sessions.ensure(sessionId, undefined, `Ingested ${detectedType} content`);

      let framesCreated = 0;
      let duplicatesSkipped = 0;
      let entitiesCreated = 0;

      // Record max frame id before the batch — see harvest.ts for rationale
      // (id-based dedup detection avoids the ISO-vs-space timestamp format
      // mismatch between JS Dates and SQLite datetime('now')).
      const rawDb = getPersonalDb().getDatabase();
      const maxBefore =
        (rawDb.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM memory_frames').get() as { m: number }).m;

      for (const item of items) {
        const frameContent = item.title
          ? `[${detectedType}] ${item.title}: ${item.content.slice(0, 3000)}`
          : `[${detectedType}] ${item.content.slice(0, 3000)}`;

        const frame = frameStore.createIFrame(
          sessionId,
          frameContent,
          importance,
          'import',
        );

        const isNew = frame.id > maxBefore;

        if (isNew) {
          framesCreated++;

          // Index for semantic search
          try {
            await search.indexFrame(frame.id, frameContent);
          } catch { /* non-fatal */ }

          // Extract entities from metadata
          const metaEntities = item.metadata?.entities;
          if (Array.isArray(metaEntities)) {
            for (const ent of metaEntities as { name: string; type: string }[]) {
              try {
                kg.createEntity(ent.type || 'concept', ent.name, {
                  source: detectedType,
                  ...(tags && { tags }),
                });
                entitiesCreated++;
              } catch { /* non-fatal */ }
            }
          }
        } else {
          duplicatesSkipped++;
        }
      }

      // Record in harvest source store
      const sourceKey = detectedType === 'url' ? 'unknown' : detectedType;
      harvestStore.upsert(
        sourceKey as Parameters<typeof harvestStore.upsert>[0],
        items[0]?.title ?? detectedType,
        content.startsWith('http') ? content : undefined,
      );
      harvestStore.recordSync(
        sourceKey as Parameters<typeof harvestStore.recordSync>[0],
        items.length,
        framesCreated,
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            source_type: detectedType,
            items_parsed: items.length,
            frames_created: framesCreated,
            duplicates_skipped: duplicatesSkipped,
            entities_created: entitiesCreated,
            ...(tags && { tags }),
          }, null, 2),
        }],
      };
    },
  );
}

/** Detect content type from the input string. */
function detectContentType(input: string): 'markdown' | 'plaintext' | 'pdf' | 'url' {
  const trimmed = input.trim();

  // URL detection
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return 'url';
  }

  // File path detection
  if (trimmed.length < 500 && !trimmed.includes('\n')) {
    const lower = trimmed.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
    if (lower.endsWith('.txt')) return 'plaintext';

    // Check if it's an existing file
    try {
      if (fs.existsSync(trimmed)) {
        if (lower.endsWith('.pdf')) return 'pdf';
        if (lower.endsWith('.md')) return 'markdown';
        return 'plaintext';
      }
    } catch { /* not a path */ }
  }

  // Content-based detection
  if (trimmed.startsWith('#') || trimmed.includes('\n## ') || trimmed.includes('\n### ')) {
    return 'markdown';
  }

  return 'plaintext';
}

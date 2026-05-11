/**
 * Wiki tools — compile, search, and browse the personal wiki.
 *
 * compile_wiki:   Trigger incremental or full compilation
 * get_page:       Read a compiled wiki page by slug
 * search_wiki:    Search compiled pages
 * compile_health: Run health check on wiki data quality
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getPersonalDb,
  getFrameStore,
  getSearch,
  getKnowledgeGraph,
  getWorkspaceMind,
} from '../core/setup.js';
import {
  WikiCompiler,
  CompilationState,
  resolveSynthesizer as resolveWikiSynthesizer,
} from '@hive-mind/wiki-compiler';
import type { ResolvedSynthesizer } from '@hive-mind/wiki-compiler';

// Cached synthesizer — resolved once on first compile_wiki call
let _synthesizer: ResolvedSynthesizer | null = null;

async function getSynthesizer(): Promise<ResolvedSynthesizer> {
  if (!_synthesizer) {
    _synthesizer = await resolveWikiSynthesizer();
    console.error(`[hive-mind-memory] Wiki synthesizer: ${_synthesizer.provider} (${_synthesizer.model})`);
  }
  return _synthesizer;
}

/**
 * Resolve the WikiCompiler + CompilationState against the right mind.
 * Without workspaceId: targets personal mind (existing behavior).
 * With workspaceId: opens the workspace mind via the LRU cache and
 * builds the wiki against its own knowledge graph + frame store. The
 * `wiki_pages` table is created on first compile via CompilationState's
 * `CREATE TABLE IF NOT EXISTS`.
 */
async function getCompiler(
  workspaceId?: string,
): Promise<{ compiler: WikiCompiler; state: CompilationState; provider: string }> {
  const synth = await getSynthesizer();

  if (workspaceId) {
    const mind = getWorkspaceMind(workspaceId);
    if (!mind) {
      throw new Error(`Workspace not found or mind unavailable: ${workspaceId}`);
    }
    const state = new CompilationState(mind.db);
    const compiler = new WikiCompiler(
      mind.knowledgeGraph,
      mind.frameStore,
      mind.search,
      state,
      { synthesize: synth.synthesize },
    );
    return { compiler, state, provider: synth.provider };
  }

  const db = getPersonalDb();
  const state = new CompilationState(db);
  const compiler = new WikiCompiler(
    getKnowledgeGraph(),
    getFrameStore(),
    getSearch(),
    state,
    { synthesize: synth.synthesize },
  );
  return { compiler, state, provider: synth.provider };
}

export function registerWikiTools(server: McpServer): void {

  // ── compile_wiki ───────────────────────────────────────────────
  server.tool(
    'compile_wiki',
    'Compile a wiki from memory frames and knowledge graph. Defaults to the personal mind; pass workspace_id to compile a workspace-scoped wiki. Incremental by default.',
    {
      mode: z.enum(['incremental', 'full']).default('incremental')
        .describe('incremental: only recompile affected pages. full: rebuild everything.'),
      concepts: z.array(z.string()).optional()
        .describe('Optional list of concept names to compile pages for. Auto-detected if omitted.'),
      workspace_id: z.string().optional()
        .describe('Compile against a workspace mind instead of personal. Workspace must exist.'),
    },
    async ({ mode, concepts, workspace_id }) => {
      const { compiler, provider } = await getCompiler(workspace_id);

      try {
        const result = await compiler.compile({
          incremental: mode === 'incremental',
          concepts: concepts ?? undefined,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              mode,
              llm_provider: provider,
              pages_created: result.pagesCreated,
              pages_updated: result.pagesUpdated,
              pages_unchanged: result.pagesUnchanged,
              entity_pages: result.entityPages,
              concept_pages: result.conceptPages,
              synthesis_pages: result.synthesisPages,
              health_issues: result.healthIssues,
              watermark: result.watermark,
              duration_ms: result.durationMs,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Compilation error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );

  // ── get_page ───────────────────────────────────────────────────
  server.tool(
    'get_page',
    'Read a compiled wiki page by its slug (e.g., "project-alpha", "index", "synthesis-memory"). Pass workspace_id to fetch from a workspace wiki.',
    {
      slug: z.string().describe('Page slug (URL-safe name). Use "index" for the wiki index.'),
      workspace_id: z.string().optional()
        .describe('Read from a workspace wiki instead of personal.'),
    },
    async ({ slug, workspace_id }) => {
      const { state } = await getCompiler(workspace_id);
      const page = state.getPage(slug);

      if (!page) {
        // Try fuzzy match
        const allPages = state.getAllPages();
        const matches = allPages.filter(p =>
          p.slug.includes(slug) || p.name.toLowerCase().includes(slug.toLowerCase()),
        );

        if (matches.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Page "${slug}" not found. Did you mean:\n${matches.map(m => `  - ${m.slug} (${m.name})`).join('\n')}`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Page "${slug}" not found. Run compile_wiki first, or use search_wiki to find pages.`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            slug: page.slug,
            name: page.name,
            type: page.pageType,
            sources: page.sourceCount,
            compiled_at: page.compiledAt,
            content_hash: page.contentHash,
          }, null, 2),
        }],
      };
    },
  );

  // ── search_wiki ────────────────────────────────────────────────
  server.tool(
    'search_wiki',
    'Search compiled wiki pages by name or type. Defaults to the personal wiki; pass workspace_id to search a workspace wiki.',
    {
      query: z.string().optional()
        .describe('Search query to match against page names'),
      type: z.enum(['entity', 'concept', 'synthesis', 'index', 'health']).optional()
        .describe('Filter by page type'),
      workspace_id: z.string().optional()
        .describe('Search a workspace wiki instead of personal.'),
    },
    async ({ query, type, workspace_id }) => {
      const { state } = await getCompiler(workspace_id);

      let pages = type
        ? state.getPagesByType(type)
        : state.getAllPages();

      if (query) {
        const lower = query.toLowerCase();
        pages = pages.filter(p =>
          p.name.toLowerCase().includes(lower) ||
          p.slug.includes(lower),
        );
      }

      if (pages.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: query
              ? `No wiki pages matching "${query}". Run compile_wiki to generate pages.`
              : 'No wiki pages compiled yet. Run compile_wiki first.',
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(pages.map(p => ({
            slug: p.slug,
            name: p.name,
            type: p.pageType,
            sources: p.sourceCount,
            compiled_at: p.compiledAt,
          })), null, 2),
        }],
      };
    },
  );

  // ── compile_health ─────────────────────────────────────────────
  server.tool(
    'compile_health',
    'Run a health check on the wiki. Reports contradictions, gaps, orphan entities, weak confidence pages, and data quality score.',
    {},
    async () => {
      const { compiler } = await getCompiler();
      const report = compiler.compileHealth();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data_quality_score: report.dataQualityScore,
            total_entities: report.totalEntities,
            total_frames: report.totalFrames,
            total_pages: report.totalPages,
            issues: report.issues.map(i => ({
              type: i.type,
              severity: i.severity,
              description: i.description,
              ...(i.suggestion && { suggestion: i.suggestion }),
            })),
            compiled_at: report.compiledAt,
          }, null, 2),
        }],
      };
    },
  );
}

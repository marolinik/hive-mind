/**
 * `hive-mind-cli recall-context [query]` — query the personal mind and
 * print matching frames. Designed to be invoked from a SessionStart
 * hook, where the stdout is injected into the AI client's conversation
 * context.
 */

import { openPersonalMind, type CliEnv } from '../setup.js';

export interface RecallContextOptions {
  query: string;
  limit?: number;
  scope?: 'personal' | 'all';
  profile?: 'balanced' | 'recent' | 'important' | 'connected';
  format?: 'plain' | 'json';
  /** Override for tests — use an already-open env instead of opening a new one. */
  env?: CliEnv;
}

export interface RecallContextResult {
  query: string;
  hits: Array<{
    id: number;
    content: string;
    importance: string;
    source: string;
    score: number;
    created_at: string;
    from: string;
  }>;
}

export async function runRecallContext(options: RecallContextOptions): Promise<RecallContextResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;

  try {
    const limit = options.limit ?? 10;
    const scope = options.scope ?? 'personal';
    const profile = options.profile ?? 'balanced';

    const search = await env.getSearch();
    const searchOpts = { limit, profile };
    const hits: RecallContextResult['hits'] = [];

    // Personal mind
    const personalResults = await search.search(options.query, searchOpts);
    for (const r of personalResults) {
      hits.push({
        id: r.frame.id,
        content: r.frame.content,
        importance: r.frame.importance,
        source: r.frame.source,
        score: Math.round(r.finalScore * 1000) / 1000,
        created_at: r.frame.created_at,
        from: 'personal',
      });
    }

    // All workspaces when scope=all
    if (scope === 'all') {
      for (const ws of env.workspaces.list()) {
        const wsDb = env.mindCache.getOrOpen(ws.id);
        if (!wsDb) continue;
        try {
          const { FrameStore, HybridSearch } = await import('@hive-mind/core');
          // Touch these to satisfy lint; they're consumed below via wsDb.
          void FrameStore;
          const wsEmbedder = await env.getEmbedder();
          const wsSearch = new HybridSearch(wsDb, wsEmbedder);
          const wsResults = await wsSearch.search(options.query, searchOpts);
          for (const r of wsResults) {
            hits.push({
              id: r.frame.id,
              content: r.frame.content,
              importance: r.frame.importance,
              source: r.frame.source,
              score: Math.round(r.finalScore * 1000) / 1000,
              created_at: r.frame.created_at,
              from: `workspace:${ws.id}`,
            });
          }
        } catch { /* workspace failures are non-fatal */ }
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const trimmed = hits.slice(0, limit);

    return { query: options.query, hits: trimmed };
  } finally {
    close();
  }
}

/** Render a recall result either as plain text (for stdout injection) or JSON. */
export function renderRecallResult(result: RecallContextResult, format: 'plain' | 'json' = 'plain'): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }
  if (result.hits.length === 0) {
    return `No memories found for query: "${result.query}"`;
  }
  const lines: string[] = [`# Recalled context for "${result.query}"`, ''];
  for (const h of result.hits) {
    const date = h.created_at.slice(0, 10);
    lines.push(`- [${h.from}/${h.importance}, ${date}, score=${h.score.toFixed(3)}] ${h.content}`);
  }
  return lines.join('\n');
}

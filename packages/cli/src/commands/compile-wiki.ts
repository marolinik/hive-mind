/**
 * `hive-mind-cli compile-wiki` — run wiki compilation against the
 * personal mind, a single workspace mind, or every registered workspace
 * in sequence. Delegates to @hive-mind/wiki-compiler with the default
 * env-driven synthesizer resolver (Anthropic → Ollama → echo).
 *
 * Workspace scoping (added 2026-05-07): each mind keeps its own
 * `wiki_pages` table. Running compile against a workspace mind first
 * creates the table on demand (CompilationState issues
 * `CREATE TABLE IF NOT EXISTS`), then walks the workspace's own
 * knowledge graph. The personal wiki is unchanged.
 */

import * as fs from 'node:fs';
import { openPersonalMind, type CliEnv } from '../setup.js';
import {
  WikiCompiler,
  CompilationState,
  resolveSynthesizer,
} from '@hive-mind/wiki-compiler';
import type { ResolvedSynthesizer } from '@hive-mind/wiki-compiler';
import {
  MindDB,
  KnowledgeGraph,
  FrameStore,
  HybridSearch,
  type EmbeddingProviderInstance,
} from '@hive-mind/core';

export interface CompileWikiOptions {
  mode?: 'incremental' | 'full';
  concepts?: string[];
  /**
   * Compile a workspace mind instead of personal. Mutually exclusive
   * with allWorkspaces. The workspace mind file must already exist
   * (created on first save_memory to that workspace).
   */
  workspace?: string;
  /**
   * Compile every registered workspace mind in sequence. Personal
   * is NOT included by default — use a separate run for that. Each
   * workspace gets its own pagesCreated/Updated counts in perMind.
   */
  allWorkspaces?: boolean;
  env?: CliEnv;
}

export interface CompileWikiResult {
  provider: string;
  model: string;
  mode: 'incremental' | 'full';
  pagesCreated: number;
  pagesUpdated: number;
  pagesUnchanged: number;
  entityPages: string[];
  conceptPages: string[];
  synthesisPages: string[];
  healthIssues: number;
  durationMs: number;
  /** Per-mind breakdown when allWorkspaces is true. */
  perMind?: Array<{
    mind: string;
    pagesCreated: number;
    pagesUpdated: number;
    pagesUnchanged: number;
    healthIssues: number;
    durationMs: number;
  }>;
}

interface CompileSingleArgs {
  db: MindDB;
  kg: KnowledgeGraph;
  frames: FrameStore;
  search: HybridSearch;
  synth: ResolvedSynthesizer;
  mode: 'incremental' | 'full';
  concepts?: string[];
}

/**
 * One compile pass against an already-open mind. Returns the raw
 * compiler result; the caller wraps it in CompileWikiResult shape.
 */
async function compileOne(args: CompileSingleArgs) {
  const state = new CompilationState(args.db);
  const compiler = new WikiCompiler(args.kg, args.frames, args.search, state, {
    synthesize: args.synth.synthesize,
  });
  return compiler.compile({
    incremental: args.mode === 'incremental',
    concepts: args.concepts,
  });
}

export async function runCompileWiki(options: CompileWikiOptions = {}): Promise<CompileWikiResult> {
  if (options.allWorkspaces) {
    return runCompileAllWorkspaces(options);
  }
  if (options.workspace) {
    return runCompileOnWorkspace(options.workspace, options);
  }
  return runCompileOnPersonal(options);
}

async function runCompileOnPersonal(options: CompileWikiOptions): Promise<CompileWikiResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  const mode = options.mode ?? 'incremental';

  try {
    const search = await env.getSearch();
    const synth = await resolveSynthesizer();
    const result = await compileOne({
      db: env.db, kg: env.kg, frames: env.frames, search, synth, mode, concepts: options.concepts,
    });

    return {
      provider: synth.provider,
      model: synth.model,
      mode,
      pagesCreated: result.pagesCreated,
      pagesUpdated: result.pagesUpdated,
      pagesUnchanged: result.pagesUnchanged,
      entityPages: result.entityPages,
      conceptPages: result.conceptPages,
      synthesisPages: result.synthesisPages,
      healthIssues: result.healthIssues,
      durationMs: result.durationMs,
    };
  } finally {
    close();
  }
}

async function runCompileOnWorkspace(workspaceId: string, options: CompileWikiOptions): Promise<CompileWikiResult> {
  // Open personal env mainly to reach WorkspaceManager + the embedder probe.
  // The actual compile runs against the workspace's own MindDB / KG.
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  const mode = options.mode ?? 'incremental';

  try {
    const wm = env.workspaces;
    const ws = wm.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    const mindPath = wm.getMindPath(workspaceId);
    if (!fs.existsSync(mindPath)) {
      throw new Error(`Workspace mind file missing: ${mindPath}. Save at least one memory to materialise it.`);
    }

    const embedder = await env.getEmbedder();
    const synth = await resolveSynthesizer();

    const wsDb = new MindDB(mindPath);
    try {
      const wsKg = new KnowledgeGraph(wsDb);
      const wsFrames = new FrameStore(wsDb);
      const wsSearch = new HybridSearch(wsDb, embedder as EmbeddingProviderInstance);
      const result = await compileOne({
        db: wsDb, kg: wsKg, frames: wsFrames, search: wsSearch, synth, mode, concepts: options.concepts,
      });

      return {
        provider: synth.provider,
        model: synth.model,
        mode,
        pagesCreated: result.pagesCreated,
        pagesUpdated: result.pagesUpdated,
        pagesUnchanged: result.pagesUnchanged,
        entityPages: result.entityPages,
        conceptPages: result.conceptPages,
        synthesisPages: result.synthesisPages,
        healthIssues: result.healthIssues,
        durationMs: result.durationMs,
      };
    } finally {
      wsDb.close();
    }
  } finally {
    close();
  }
}

async function runCompileAllWorkspaces(options: CompileWikiOptions): Promise<CompileWikiResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  const mode = options.mode ?? 'incremental';

  try {
    const embedder = await env.getEmbedder();
    const synth = await resolveSynthesizer();

    const perMind: NonNullable<CompileWikiResult['perMind']> = [];
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalUnchanged = 0;
    let totalHealth = 0;
    let totalDuration = 0;

    for (const ws of env.workspaces.list()) {
      const mindPath = env.workspaces.getMindPath(ws.id);
      if (!fs.existsSync(mindPath)) continue;
      try {
        const wsDb = new MindDB(mindPath);
        try {
          const wsKg = new KnowledgeGraph(wsDb);
          const wsFrames = new FrameStore(wsDb);
          const wsSearch = new HybridSearch(wsDb, embedder as EmbeddingProviderInstance);
          const r = await compileOne({
            db: wsDb, kg: wsKg, frames: wsFrames, search: wsSearch, synth, mode, concepts: options.concepts,
          });
          perMind.push({
            mind: ws.id,
            pagesCreated: r.pagesCreated,
            pagesUpdated: r.pagesUpdated,
            pagesUnchanged: r.pagesUnchanged,
            healthIssues: r.healthIssues,
            durationMs: r.durationMs,
          });
          totalCreated += r.pagesCreated;
          totalUpdated += r.pagesUpdated;
          totalUnchanged += r.pagesUnchanged;
          totalHealth += r.healthIssues;
          totalDuration += r.durationMs;
        } finally {
          wsDb.close();
        }
      } catch (err) {
        // One bad workspace shouldn't abort the rest. Surface and continue.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[compile-wiki] workspace ${ws.id} failed: ${msg}\n`);
        perMind.push({
          mind: ws.id, pagesCreated: 0, pagesUpdated: 0, pagesUnchanged: 0,
          healthIssues: 0, durationMs: 0,
        });
      }
    }

    return {
      provider: synth.provider,
      model: synth.model,
      mode,
      pagesCreated: totalCreated,
      pagesUpdated: totalUpdated,
      pagesUnchanged: totalUnchanged,
      entityPages: [],
      conceptPages: [],
      synthesisPages: [],
      healthIssues: totalHealth,
      durationMs: totalDuration,
      perMind,
    };
  } finally {
    close();
  }
}

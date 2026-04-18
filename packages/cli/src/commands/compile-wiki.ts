/**
 * `hive-mind-cli compile-wiki` — run wiki compilation against the
 * personal mind. Delegates to @hive-mind/wiki-compiler with the
 * default env-driven synthesizer resolver (Anthropic → Ollama → echo).
 */

import { openPersonalMind, type CliEnv } from '../setup.js';
import {
  WikiCompiler,
  CompilationState,
  resolveSynthesizer,
} from '@hive-mind/wiki-compiler';

export interface CompileWikiOptions {
  mode?: 'incremental' | 'full';
  concepts?: string[];
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
}

export async function runCompileWiki(options: CompileWikiOptions = {}): Promise<CompileWikiResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  const mode = options.mode ?? 'incremental';

  try {
    const state = new CompilationState(env.db);
    const search = await env.getSearch();
    const synth = await resolveSynthesizer();
    const compiler = new WikiCompiler(env.kg, env.frames, search, state, {
      synthesize: synth.synthesize,
    });

    const result = await compiler.compile({
      incremental: mode === 'incremental',
      concepts: options.concepts,
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

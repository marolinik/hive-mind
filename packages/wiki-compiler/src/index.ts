/**
 * @hive-mind/wiki-compiler — LLM-powered knowledge synthesis.
 *
 * Takes a MindDB instance (from @hive-mind/core) and compiles memory
 * frames plus knowledge-graph entities into interlinked wiki pages.
 *
 * Five page types:
 *   entity     — per-entity synthesis (name, facts, timeline, relations,
 *                open questions, contradictions)
 *   concept    — per-topic synthesis with related-entity back-links
 *   synthesis  — cross-source pattern detection (agreements,
 *                contradictions, emergent insights)
 *   index      — navigable catalog of all compiled pages
 *   health     — data-quality report (gaps, orphans, weak confidence)
 *
 * See CompilerConfig for the LLM callback contract, and
 * resolveSynthesizer() for the built-in provider chain (Anthropic
 * Haiku → Ollama → echo fallback).
 */

export { WikiCompiler } from './compiler.js';
export { CompilationState, contentHash } from './state.js';
export { resolveSynthesizer } from './synthesizer.js';
export type { ResolvedSynthesizer, SynthesizerConfig } from './synthesizer.js';
export { entityPagePrompt, conceptPagePrompt, synthesisPagePrompt } from './prompts.js';
export type {
  WikiPage,
  WikiPageType,
  WikiPageFrontmatter,
  CompilationWatermark,
  PageRecord,
  CompilerConfig,
  LLMSynthesizeFn,
  CompilationResult,
  HealthReport,
  HealthIssue,
  HealthIssueType,
} from './types.js';

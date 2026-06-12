// Harvest pipeline public surface.
//
// Wave 3A (foundation): universal types, text chunker, LLM prompts,
//   HarvestSourceStore, local dedup.
// Wave 3B (parse-only adapters): 9 source-specific adapters that turn
//   provider exports / documents / URLs into UniversalImportItem[].
// Wave 3C: claude-code filesystem adapter + 3-pass HarvestPipeline orchestrator.
//   Harvest extraction is complete after 3C.
// See EXTRACTION.md for the file map.

// Foundation
export * from './types.js';
export { chunkByParagraphs } from './chunk-utils.js';
export { CLASSIFY_PROMPT, EXTRACT_PROMPT, SYNTHESIZE_PROMPT } from './prompts.js';
export { HarvestSourceStore } from './source-store.js';
export { dedup, harvestSetHash } from './dedup.js';
export type { DedupResult } from './dedup.js';
export { asRecord, getString, getNumber, getArray, firstString } from './raw-types.js';
export type { RawRecord } from './raw-types.js';

// Parse-only adapters (Wave 3B)
export { ChatGPTAdapter } from './chatgpt-adapter.js';
export { ClaudeAdapter } from './claude-adapter.js';
export { GeminiAdapter } from './gemini-adapter.js';
export { PerplexityAdapter } from './perplexity-adapter.js';
export { PlaintextAdapter } from './plaintext-adapter.js';
export { MarkdownAdapter } from './markdown-adapter.js';
export { UrlAdapter } from './url-adapter.js';
export { PdfAdapter } from './pdf-adapter.js';
export { UniversalAdapter } from './universal-adapter.js';

// Claude Code filesystem adapter (Wave 3C)
export { ClaudeCodeAdapter } from './claude-code-adapter.js';

// Pipeline orchestrator (Wave 3C)
export { HarvestPipeline } from './pipeline.js';
export type { LLMCallFn, PipelineOptions } from './pipeline.js';

// Harvest run lifecycle tracking (backported from Waggle OS — resume/interrupt support)
export { HarvestRunStore } from './run-store.js';
export type { HarvestRun, HarvestRunStatus } from './run-store.js';

// Memory-lane extraction passes (facts / events / profiles).
// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
export {
  extractMemoryLanes,
  writeMemoryLaneFrames,
  MIND_FACT_PREFIX,
  MIND_EVENT_PREFIX,
  MIND_PROFILE_PREFIX,
} from './extract-memory-lanes.js';
export type {
  ExtractedFact,
  ExtractedEvent,
  ExtractedProfile,
  MemoryLaneExtraction,
  WriteLaneFramesResult,
} from './extract-memory-lanes.js';

// Per-turn verbatim dialogue storage (raw-detail lane, write side).
// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
export {
  writeRawTurnFrames,
  rawTurnHeader,
  parseRawTurnHeader,
  rawTurnConvKey,
  MIND_RAWTURN_PREFIX,
  MAX_TURNS_PER_ITEM,
  RAWDETAIL_KILL_SWITCH,
} from './raw-turns.js';
export type { WriteRawTurnsResult, ParsedRawTurnHeader } from './raw-turns.js';

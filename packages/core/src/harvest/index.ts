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
export { dedup } from './dedup.js';
export type { DedupResult } from './dedup.js';

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

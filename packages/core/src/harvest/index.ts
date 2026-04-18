// Harvest pipeline public surface.
//
// Wave 3A ships the foundation layer: universal types, the text-chunking
// helper, LLM prompt templates, the source-tracking store, and the local
// dedup filter. Wave 3B adds the source-specific adapters. Wave 3C adds
// the pipeline orchestrator and the two largest adapters (claude-code,
// pipeline.ts). See EXTRACTION.md for the file map.

export * from './types.js';
export { chunkByParagraphs } from './chunk-utils.js';
export { CLASSIFY_PROMPT, EXTRACT_PROMPT, SYNTHESIZE_PROMPT } from './prompts.js';
export { HarvestSourceStore } from './source-store.js';
export { dedup } from './dedup.js';
export type { DedupResult } from './dedup.js';

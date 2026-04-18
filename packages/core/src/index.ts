// @hive-mind/core — Memory substrate
//
// This package grows wave-by-wave as Waggle OS modules are extracted.
// Current surface:
//   Wave 1  (schema + MindDB)            — SQLite-backed schema and base DB.
//   Wave 2A (embedding providers)        — InProcess / Ollama / API / LiteLLM /
//                                          Mock fallback chain behind a single
//                                          createEmbeddingProvider factory.
//   Wave 2B (frames + sessions)          — FrameStore (I/P/B memory frames with
//                                          FTS+vec sync, dedup, compaction) and
//                                          SessionStore (GOP session lifecycle).
//   Wave 2C (hybrid search + scoring)    — HybridSearch (RRF fusion over FTS5 +
//                                          sqlite-vec, k=60) and a 4-profile
//                                          personalization scoring layer.
//   Wave 2D (knowledge + concepts)       — KnowledgeGraph (bitemporal entities +
//                                          relations, typed BFS traversal),
//                                          Ontology validator, entity-name
//                                          normalization/dedup utilities, and
//                                          ConceptTracker (spaced-repetition
//                                          mastery on 1-5 scale).
//   Wave 2E (identity + awareness)       — IdentityLayer (single-row "who am I"
//                                          persistence with context rendering)
//                                          and AwarenessLayer (short-lived
//                                          task/action/pending/flag items with
//                                          TTL and metadata).
//   Wave 2F (index reconciliation)       — Repair helpers for FTS5 + sqlite-vec
//                                          after crashes (find orphaned frames,
//                                          re-index) plus orphan sweeps in the
//                                          reverse direction. Last module in
//                                          the mind/ substrate.
//   Wave 3A (harvest foundation)         — Universal import types,
//                                          paragraph chunker, LLM prompt
//                                          templates, HarvestSourceStore, and
//                                          local dedup (hash + trigram) with
//                                          contradiction detection. Adapters
//                                          and pipeline orchestrator follow in
//                                          3B / 3C.
// See EXTRACTION.md in the repository root for the full roadmap.

export const VERSION = '0.1.0';

// Database substrate
export { MindDB } from './mind/db.js';
export { SCHEMA_SQL, VEC_TABLE_SQL, SCHEMA_VERSION } from './mind/schema.js';

// Memory frames
export { FrameStore } from './mind/frames.js';
export type {
  FrameType,
  Importance,
  FrameSource,
  MemoryFrame,
  ReconstructedState,
} from './mind/frames.js';

// Sessions
export { SessionStore } from './mind/sessions.js';
export type { Session } from './mind/sessions.js';

// Harvest pipeline (Wave 3A foundation: types + chunker + prompts + source
// store + dedup; adapters and orchestrator added in 3B / 3C).
export * from './harvest/index.js';

// Index reconciliation (maintenance helpers)
export {
  reconcileFtsIndex,
  reconcileVecIndex,
  cleanOrphanFts,
  cleanOrphanVectors,
  reconcileIndexes,
} from './mind/reconcile.js';
export type { ReconcileResult } from './mind/reconcile.js';

// Identity + awareness
export { IdentityLayer } from './mind/identity.js';
export type { Identity } from './mind/identity.js';
export { AwarenessLayer } from './mind/awareness.js';
export type {
  AwarenessCategory,
  AwarenessMetadata,
  AwarenessItem,
} from './mind/awareness.js';

// Knowledge graph
export { KnowledgeGraph } from './mind/knowledge.js';
export type {
  Entity,
  Relation,
  EntityTypeSchema,
  ValidationSchema,
} from './mind/knowledge.js';
export { Ontology, validateEntity } from './mind/ontology.js';
export type { EntitySchema, ValidationResult } from './mind/ontology.js';
export { normalizeEntityName, findDuplicates } from './mind/entity-normalizer.js';
export type { EntityRef } from './mind/entity-normalizer.js';
export { ConceptTracker, CONCEPT_MASTERY_TABLE_SQL } from './mind/concept-tracker.js';
export type { ConceptEntry, ConceptUpdate } from './mind/concept-tracker.js';

// Hybrid search + scoring
export { HybridSearch } from './mind/search.js';
export type { SearchOptions, SearchResult } from './mind/search.js';
export {
  SCORING_PROFILES,
  computeTemporalScore,
  computePopularityScore,
  computeContextualScore,
  computeImportanceScore,
  computeRelevance,
} from './mind/scoring.js';
export type {
  ScoringProfile,
  ScoringWeights,
  ScoringContext,
  ScoredResult,
} from './mind/scoring.js';

// Embedding providers
export type { Embedder } from './mind/embeddings.js';
export { createEmbeddingProvider } from './mind/embedding-provider.js';
export type {
  EmbeddingProviderType,
  EmbeddingProviderConfig,
  EmbeddingProviderStatus,
  EmbeddingProviderInstance,
} from './mind/embedding-provider.js';
export { createInProcessEmbedder, normalizeDimensions } from './mind/inprocess-embedder.js';
export type { InProcessEmbedderConfig } from './mind/inprocess-embedder.js';
export { createOllamaEmbedder } from './mind/ollama-embedder.js';
export type { OllamaEmbedderConfig } from './mind/ollama-embedder.js';
export { createApiEmbedder } from './mind/api-embedder.js';
export type { ApiEmbedderConfig } from './mind/api-embedder.js';
export { createLiteLLMEmbedder } from './mind/litellm-embedder.js';
export type { LiteLLMEmbedderConfig } from './mind/litellm-embedder.js';

// Logger
export { createCoreLogger } from './logger.js';
export type { CoreLogger } from './logger.js';

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
// Subsequent waves add HybridSearch, KnowledgeGraph, IdentityLayer,
// AwarenessLayer, and the harvest pipeline. See EXTRACTION.md in the repository
// root for the full roadmap.

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

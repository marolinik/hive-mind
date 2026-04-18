// @hive-mind/core — Memory substrate
//
// This package will grow as Waggle OS modules are extracted. Wave 1 (current)
// ships the SQLite-backed schema and the MindDB primitive. Subsequent waves
// add FrameStore, HybridSearch, KnowledgeGraph, IdentityLayer, AwarenessLayer,
// SessionStore, the embedding providers, and the harvest pipeline. See
// EXTRACTION.md in the repository root for the full roadmap.

export const VERSION = '0.1.0';

export { MindDB } from './mind/db.js';
export { SCHEMA_SQL, VEC_TABLE_SQL, SCHEMA_VERSION } from './mind/schema.js';

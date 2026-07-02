// SQL schema for the hive-mind memory substrate.
//
// This is the open-source subset extracted from Waggle OS. It defines the core
// memory layers (identity, awareness, sessions, I/P/B memory frames, knowledge
// graph, harvest sources) plus the FTS5 and sqlite-vec virtual tables.
//
// Intentionally EXCLUDED from this schema (remain proprietary to Waggle OS):
//   - ai_interactions    — EU AI Act Art. 12 audit log + append-only triggers
//   - execution_traces   — agent run history for self-evolution
//   - evolution_runs     — GEPA / EvolveSchema run storage
//   - improvement_signals — workflow-pattern + capability-gap detection
//   - procedures         — optimized prompt templates
//   - install_audit      — capability install trust trail
//
// Downstream consumers of this schema are free to add their own tables via
// additive migrations. hive-mind uses `CREATE TABLE IF NOT EXISTS` throughout
// so re-running SCHEMA_SQL against an extended database is a safe no-op for the
// built-in tables.

export const SCHEMA_VERSION = '1';

export const SCHEMA_SQL = `
-- Meta table for schema versioning and install timestamps
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Layer 0: Identity (single row, <500 tokens)
CREATE TABLE IF NOT EXISTS identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Layer 1: Awareness (<=10 active items)
CREATE TABLE IF NOT EXISTS awareness (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('task', 'action', 'pending', 'flag')),
  content TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

-- Sessions: map GOPs (Group of Pictures) to projects
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gop_id TEXT NOT NULL UNIQUE,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_id, started_at);

-- Layer 2: Memory Frames (I/P/B with GOP organization)
CREATE TABLE IF NOT EXISTS memory_frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_type TEXT NOT NULL CHECK (frame_type IN ('I', 'P', 'B')),
  gop_id TEXT NOT NULL,
  t INTEGER NOT NULL DEFAULT 0,
  base_frame_id INTEGER REFERENCES memory_frames(id),
  content TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'normal'
    CHECK (importance IN ('critical', 'important', 'normal', 'temporary', 'deprecated')),
  source TEXT NOT NULL DEFAULT 'user_stated'
    CHECK (source IN ('user_stated', 'tool_verified', 'agent_inferred', 'import', 'system')),
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
  content_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (gop_id) REFERENCES sessions(gop_id)
);
CREATE INDEX IF NOT EXISTS idx_frames_gop_t ON memory_frames (gop_id, t);
CREATE INDEX IF NOT EXISTS idx_frames_type ON memory_frames (frame_type, gop_id);
CREATE INDEX IF NOT EXISTS idx_frames_base ON memory_frames (base_frame_id);
-- Indexed content hash for O(1) global dedup (replaces the legacy last-500 scan).
CREATE INDEX IF NOT EXISTS idx_frames_content_hash ON memory_frames (content_hash);

-- FTS5 for keyword search on frame content
CREATE VIRTUAL TABLE IF NOT EXISTS memory_frames_fts USING fts5(
  content,
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Layer 3: Knowledge Graph — Entities (with bitemporal validity)
CREATE TABLE IF NOT EXISTS knowledge_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_to TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON knowledge_entities (entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON knowledge_entities (name);

-- Layer 3: Knowledge Graph — Relations (with bitemporal validity)
CREATE TABLE IF NOT EXISTS knowledge_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES knowledge_entities(id),
  target_id INTEGER NOT NULL REFERENCES knowledge_entities(id),
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  properties TEXT NOT NULL DEFAULT '{}',
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_to TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON knowledge_relations (source_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_relations_target ON knowledge_relations (target_id, relation_type);

-- Knowledge Graph - Entity↔Frame bridge: which frames an entity was extracted
-- from, so the 'contextual' scoring signal can map query-seeded graph distances
-- back onto frames. ON DELETE CASCADE keeps it consistent with frame/entity removal.
CREATE TABLE IF NOT EXISTS kg_entity_frames (
  entity_id INTEGER NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  frame_id INTEGER NOT NULL REFERENCES memory_frames(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, frame_id)
);
CREATE INDEX IF NOT EXISTS idx_kg_entity_frames_frame ON kg_entity_frames (frame_id);
CREATE INDEX IF NOT EXISTS idx_kg_entity_frames_entity ON kg_entity_frames (entity_id);

-- Harvest Sources: track memory-harvest sync state per source
CREATE TABLE IF NOT EXISTS harvest_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  source_path TEXT,
  last_synced_at TEXT,
  items_imported INTEGER NOT NULL DEFAULT 0,
  frames_created INTEGER NOT NULL DEFAULT 0,
  auto_sync INTEGER NOT NULL DEFAULT 0,
  sync_interval_hours INTEGER NOT NULL DEFAULT 24,
  last_content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Memory frame chunks: paragraph-level subdivisions of memory_frames for
-- semantic-search precision. One frame produces N chunks (N=1 for short
-- frames). Each chunk gets its own embedding in memory_frame_chunks_vec.
-- Recall maps top-K chunks back to parent frames via frame_id.
CREATE TABLE IF NOT EXISTS memory_frame_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_id INTEGER NOT NULL REFERENCES memory_frames(id) ON DELETE CASCADE,
  chunk_idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(frame_id, chunk_idx)
);
CREATE INDEX IF NOT EXISTS idx_chunks_frame ON memory_frame_chunks (frame_id);

-- Verbatim Provenance Archive (#7, 2026-06-30): append-only, immutable, full-fidelity
-- copy of each harvested source item. Distilled/imported frames link back via
-- memory_frames.metadata.archiveUid. NOT part of the retrieval corpus (no FTS/vec) —
-- audit/reconstruction only. Append-only enforced by BEFORE UPDATE/DELETE triggers,
-- with ONE exception: a one-time GDPR Art.17 redaction (see raw_archive_no_update).
CREATE TABLE IF NOT EXISTS raw_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_uid TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_ref TEXT,
  title TEXT,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  injection_flagged INTEGER NOT NULL DEFAULT 0,
  injection_flags TEXT NOT NULL DEFAULT '',
  source_timestamp TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- GDPR Art.17 erasure: NULL until a data-subject erasure request. When set, the
  -- audit skeleton (id/source/refs/timestamps) is frozen as the audit record while
  -- content/content_sha256/title are redacted AND archive_uid is ROTATED to an opaque
  -- id (the old content-derived uid was a re-identification vector — see the trigger).
  erased_at TEXT,
  erased_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_archive_source_ref ON raw_archive (source, source_ref);
CREATE INDEX IF NOT EXISTS idx_raw_archive_created ON raw_archive (created_at DESC);
-- Append-only EXCEPT a single, one-directional GDPR Art.17 redaction. The trigger
-- pins the EXACT permitted outcome — not just the transition — so raw SQL cannot
-- abuse the erasure path to forge audit content: it is allowed ONLY when erased_at
-- goes NULL -> a non-empty value, every AUDIT column (id/source/refs/timestamps/
-- injection) is unchanged, the archive_uid is ROTATED to a new non-empty value
-- (content-derived uid must not survive — re-identification vector), AND the row
-- lands on the canonical redaction (content = marker, content_sha256 = '', title
-- NULL). erased_reason is the only free field. The content literal below MUST stay
-- byte-identical to RAW_ARCHIVE_REDACTION_MARKER in raw-archive.ts, and this whole
-- WHEN clause byte-identical to the db.ts runMigrations() recreation.
CREATE TRIGGER IF NOT EXISTS raw_archive_no_update
BEFORE UPDATE ON raw_archive
WHEN NOT (
  OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND NEW.erased_at <> ''
  AND NEW.content = '[REDACTED — GDPR Art.17 erasure]'
  AND NEW.content_sha256 = ''
  AND NEW.title IS NULL
  AND NEW.id IS OLD.id
  AND NEW.archive_uid <> OLD.archive_uid
  AND NEW.archive_uid <> ''
  AND NEW.source IS OLD.source
  AND NEW.source_ref IS OLD.source_ref
  AND NEW.created_at IS OLD.created_at
  AND NEW.source_timestamp IS OLD.source_timestamp
  AND NEW.injection_flagged IS OLD.injection_flagged
  AND NEW.injection_flags IS OLD.injection_flags
)
BEGIN SELECT RAISE(ABORT, 'raw_archive is append-only; only a one-time canonical GDPR Art.17 redaction is permitted'); END;
CREATE TRIGGER IF NOT EXISTS raw_archive_no_delete
BEFORE DELETE ON raw_archive
BEGIN SELECT RAISE(ABORT, 'raw_archive is append-only (verbatim provenance archive)'); END;
`;

// The sqlite-vec virtual table is created separately because it requires the
// `vec0` module loaded via `sqlite_vec.load()` — that call happens in MindDB's
// constructor before SCHEMA_SQL + VEC_TABLE_SQL are executed.
//
// Two virtual tables:
//   memory_frames_vec        — whole-frame embeddings (legacy + fallback)
//   memory_frame_chunks_vec  — chunk-level embeddings (primary search target)
// Recall fuses both signals via RRF; chunks dominate when populated.
/** Vec-table DDL parameterized by embedding dimension. vec0 columns can't be
 *  ALTERed, so changing dimension means DROP + CREATE (see MindDB.recreateVecTables). */
export function vecTableSqlForDim(dim: number): string {
  const d = Math.trunc(dim);
  return `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_frames_vec USING vec0(
  embedding float[${d}]
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_frame_chunks_vec USING vec0(
  embedding float[${d}]
);
`;
}

/** Default vec schema at the canonical 1024-dim (used on first init + migrations). */
export const VEC_TABLE_SQL = vecTableSqlForDim(1024);

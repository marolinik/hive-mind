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
  FOREIGN KEY (gop_id) REFERENCES sessions(gop_id)
);
CREATE INDEX IF NOT EXISTS idx_frames_gop_t ON memory_frames (gop_id, t);
CREATE INDEX IF NOT EXISTS idx_frames_type ON memory_frames (frame_type, gop_id);
CREATE INDEX IF NOT EXISTS idx_frames_base ON memory_frames (base_frame_id);

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
`;

// The sqlite-vec virtual table is created separately because it requires the
// `vec0` module loaded via `sqlite_vec.load()` — that call happens in MindDB's
// constructor before SCHEMA_SQL + VEC_TABLE_SQL are executed.
export const VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_frames_vec USING vec0(
  embedding float[1024]
);
`;

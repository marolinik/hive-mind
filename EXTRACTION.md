# Extraction Map: Waggle OS -> hive-mind

This document tracks which files from the Waggle OS monorepo map to which
hive-mind package, and which files intentionally stay proprietary.

## Extracted to `@hive-mind/core`

### Mind Substrate (`@waggle/core/src/mind/` -> `@hive-mind/core/src/mind/`)

| Waggle OS source | hive-mind target | What it does |
|---|---|---|
| `mind/db.ts` | `mind/db.ts` | MindDB (better-sqlite3 + sqlite-vec) |
| `mind/schema.ts` | `mind/schema.ts` | SCHEMA_SQL + VEC_TABLE_SQL |
| `mind/frames.ts` | `mind/frames.ts` | FrameStore: I/P/B frames, compaction, dedup |
| `mind/search.ts` | `mind/search.ts` | HybridSearch: FTS5 + vec0 fused via RRF |
| `mind/knowledge.ts` | `mind/knowledge.ts` | KnowledgeGraph: entity-relation with bitemporal validity |
| `mind/identity.ts` | `mind/identity.ts` | IdentityLayer: personal identity persistence |
| `mind/awareness.ts` | `mind/awareness.ts` | AwarenessLayer: active task/state tracking |
| `mind/sessions.ts` | `mind/sessions.ts` | SessionStore: GOP session management |
| `mind/scoring.ts` | `mind/scoring.ts` | Scoring profiles for search ranking |
| `mind/reconcile.ts` | `mind/reconcile.ts` | Memory reconciliation |
| `mind/ontology.ts` | `mind/ontology.ts` | Domain ontology |
| `mind/concept-tracker.ts` | `mind/concept-tracker.ts` | Concept frequency/salience tracking |
| `mind/entity-normalizer.ts` | `mind/entity-normalizer.ts` | Entity name normalization |
| `mind/embedding-provider.ts` | `mind/embedding-provider.ts` | Embedding provider interface |
| `mind/embeddings.ts` | `mind/embeddings.ts` | Embedding utilities |
| `mind/api-embedder.ts` | `mind/api-embedder.ts` | API-based embedding provider |
| `mind/inprocess-embedder.ts` | `mind/inprocess-embedder.ts` | In-process embedding provider |
| `mind/litellm-embedder.ts` | `mind/litellm-embedder.ts` | LiteLLM embedding provider |
| `mind/ollama-embedder.ts` | `mind/ollama-embedder.ts` | Ollama embedding provider |

### Harvest Pipeline (`@waggle/core/src/harvest/` -> `@hive-mind/core/src/harvest/`)

| Waggle OS source | hive-mind target | What it does |
|---|---|---|
| `harvest/pipeline.ts` | `harvest/pipeline.ts` | Main harvest pipeline orchestrator |
| `harvest/dedup.ts` | `harvest/dedup.ts` | Content deduplication |
| `harvest/types.ts` | `harvest/types.ts` | Shared harvest types |
| `harvest/prompts.ts` | `harvest/prompts.ts` | LLM prompts for extraction |
| `harvest/source-store.ts` | `harvest/source-store.ts` | Source tracking |
| `harvest/chunk-utils.ts` | `harvest/chunk-utils.ts` | Text chunking utilities |
| `harvest/chatgpt-adapter.ts` | `harvest/chatgpt-adapter.ts` | ChatGPT export adapter |
| `harvest/claude-adapter.ts` | `harvest/claude-adapter.ts` | Claude export adapter |
| `harvest/claude-code-adapter.ts` | `harvest/claude-code-adapter.ts` | Claude Code session adapter |
| `harvest/gemini-adapter.ts` | `harvest/gemini-adapter.ts` | Gemini export adapter |
| `harvest/perplexity-adapter.ts` | `harvest/perplexity-adapter.ts` | Perplexity export adapter |
| `harvest/pdf-adapter.ts` | `harvest/pdf-adapter.ts` | PDF document adapter |
| `harvest/plaintext-adapter.ts` | `harvest/plaintext-adapter.ts` | Plain text adapter |
| `harvest/markdown-adapter.ts` | `harvest/markdown-adapter.ts` | Markdown document adapter |
| `harvest/url-adapter.ts` | `harvest/url-adapter.ts` | URL/web page adapter |
| `harvest/universal-adapter.ts` | `harvest/universal-adapter.ts` | Universal format adapter |

### Utilities

| Waggle OS source | hive-mind target | What it does |
|---|---|---|
| `logger.ts` | `src/logger.ts` | Structured logger (createCoreLogger) |
| `config.ts` | `src/config.ts` | Configuration loader |
| `migration.ts` | `src/migration.ts` | Schema migration runner |

## Extracted to `@hive-mind/wiki-compiler`

| Waggle OS source | hive-mind target | What it does |
|---|---|---|
| `@waggle/wiki-compiler/src/compiler.ts` | `src/compiler.ts` | Wiki compilation engine |
| `@waggle/wiki-compiler/src/synthesizer.ts` | `src/synthesizer.ts` | LLM-powered synthesis |
| `@waggle/wiki-compiler/src/prompts.ts` | `src/prompts.ts` | Synthesis prompts |
| `@waggle/wiki-compiler/src/state.ts` | `src/state.ts` | Compilation state tracking |
| `@waggle/wiki-compiler/src/types.ts` | `src/types.ts` | Wiki types |
| `@waggle/wiki-compiler/src/index.ts` | `src/index.ts` | Package barrel |

## Extracted to `@hive-mind/mcp-server`

| Waggle OS source | hive-mind target | What it does |
|---|---|---|
| `@waggle/memory-mcp/src/index.ts` | `src/index.ts` | MCP server entry point |
| `@waggle/memory-mcp/src/core/setup.ts` | `src/core/setup.ts` | Initialization + shutdown |
| `@waggle/memory-mcp/src/tools/memory.ts` | `src/tools/memory.ts` | recall_memory, save_memory |
| `@waggle/memory-mcp/src/tools/knowledge.ts` | `src/tools/knowledge.ts` | search_entities, add_relation, get_entity |
| `@waggle/memory-mcp/src/tools/identity.ts` | `src/tools/identity.ts` | get_identity, set_identity |
| `@waggle/memory-mcp/src/tools/awareness.ts` | `src/tools/awareness.ts` | get_awareness, set_awareness, clear_awareness |
| `@waggle/memory-mcp/src/tools/workspace.ts` | `src/tools/workspace.ts` | list_workspaces, switch_workspace |
| `@waggle/memory-mcp/src/tools/harvest.ts` | `src/tools/harvest.ts` | harvest_conversations, harvest_status |
| `@waggle/memory-mcp/src/tools/cleanup.ts` | `src/tools/cleanup.ts` | compact_memory, cleanup_deprecated |
| `@waggle/memory-mcp/src/tools/ingest.ts` | `src/tools/ingest.ts` | ingest_source |
| `@waggle/memory-mcp/src/tools/wiki.ts` | `src/tools/wiki.ts` | compile_wiki, search_wiki, get_page, compile_health |
| `@waggle/memory-mcp/src/resources/memory.ts` | `src/resources/memory.ts` | MCP resource definitions |

## NOT Extracted (stays in Waggle OS)

These components are proprietary to Waggle OS and are NOT part of hive-mind:

| Waggle OS path | Why it stays |
|---|---|
| `packages/core/src/mind/vault.ts` | Secret storage -- Waggle-specific |
| `packages/core/src/compliance/*` | EU AI Act compliance layer -- upgrade trigger for Waggle Pro/Teams |
| `packages/core/src/mind/evolution-runs.ts` | Self-evolution run store -- Waggle agent feature |
| `packages/core/src/mind/execution-traces.ts` | Execution trace store -- Waggle agent feature |
| `packages/core/src/mind/improvement-signals.ts` | Improvement signal store -- Waggle agent feature |
| `packages/agent/*` | Entire agent runtime -- Waggle-only |
| `packages/shared/src/tiers.ts` | Tier/billing system -- Waggle-only |
| `packages/server/*` | Fastify sidecar -- Waggle-only |
| `app/*` | Tauri desktop shell -- Waggle-only |
| `apps/web/*` | Waggle web UI -- Waggle-only |

## Shared Types

From `@waggle/shared/src/types.ts`, only extract memory-related types:

- `MemoryFrame`, `FrameType`, `Importance`, `FrameSource`
- `SearchResult`, `SearchOptions`
- `KnowledgeEntity`, `KnowledgeRelation`
- `WikiPage`, `WikiCompilationResult`
- `HarvestSource`, `HarvestResult`
- `IdentityData`, `AwarenessItem`

Do NOT extract: `User`, `Team`, `AgentDef`, `Task`, `WaggleMessage`, `TierCapabilities`

## Extraction Checklist

- [ ] Remove all `@waggle/` import paths, replace with `@hive-mind/`
- [ ] Remove vault.ts dependency (replace with env-var config)
- [ ] Remove tier-gating checks (everything is free in hive-mind)
- [ ] Remove telemetry calls (or make opt-in)
- [ ] Remove compliance hooks
- [ ] Update data directory from `~/.waggle/` to `~/.hive-mind/`
- [ ] Add standalone configuration (no Fastify server dependency)
- [ ] Ensure all SQLite operations use parameterized queries
- [ ] Replace Waggle-specific logger with standalone pino/winston
- [ ] Add comprehensive JSDoc for all public APIs
- [ ] Write tests for all extracted modules (target: 80% coverage)

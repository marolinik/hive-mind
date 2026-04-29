# Extraction Map: Waggle OS -&gt; hive-mind

This document tracks which files from the Waggle OS monorepo map to which hive-mind package, and which files intentionally stay proprietary.

## Extracted to `@hive-mind/core`

### Mind Substrate (`@waggle/core/src/mind/` -&gt; `@hive-mind/core/src/mind/`)

Waggle OS sourcehive-mind targetWhat it does`mind/db.tsmind/db.ts`MindDB (better-sqlite3 + sqlite-vec)`mind/schema.tsmind/schema.ts`SCHEMA_SQL + VEC_TABLE_SQL`mind/frames.tsmind/frames.ts`FrameStore: I/P/B frames, compaction, dedup`mind/search.tsmind/search.ts`HybridSearch: FTS5 + vec0 fused via RRF`mind/knowledge.tsmind/knowledge.ts`KnowledgeGraph: entity-relation with bitemporal validity`mind/identity.tsmind/identity.ts`IdentityLayer: personal identity persistence`mind/awareness.tsmind/awareness.ts`AwarenessLayer: active task/state tracking`mind/sessions.tsmind/sessions.ts`SessionStore: GOP session management`mind/scoring.tsmind/scoring.ts`Scoring profiles for search ranking`mind/reconcile.tsmind/reconcile.ts`Memory reconciliation`mind/ontology.tsmind/ontology.ts`Domain ontology`mind/concept-tracker.tsmind/concept-tracker.ts`Concept frequency/salience tracking`mind/entity-normalizer.tsmind/entity-normalizer.ts`Entity name normalization`mind/embedding-provider.tsmind/embedding-provider.ts`Embedding provider interface`mind/embeddings.tsmind/embeddings.ts`Embedding utilities`mind/api-embedder.tsmind/api-embedder.ts`API-based embedding provider`mind/inprocess-embedder.tsmind/inprocess-embedder.ts`In-process embedding provider`mind/litellm-embedder.tsmind/litellm-embedder.ts`LiteLLM embedding provider`mind/ollama-embedder.tsmind/ollama-embedder.ts`Ollama embedding provider

### Harvest Pipeline (`@waggle/core/src/harvest/` -&gt; `@hive-mind/core/src/harvest/`)

Waggle OS sourcehive-mind targetWhat it does`harvest/pipeline.tsharvest/pipeline.ts`Main harvest pipeline orchestrator`harvest/dedup.tsharvest/dedup.ts`Content deduplication`harvest/types.tsharvest/types.ts`Shared harvest types`harvest/prompts.tsharvest/prompts.ts`LLM prompts for extraction`harvest/source-store.tsharvest/source-store.ts`Source tracking`harvest/chunk-utils.tsharvest/chunk-utils.ts`Text chunking utilities`harvest/chatgpt-adapter.tsharvest/chatgpt-adapter.ts`ChatGPT export adapter`harvest/claude-adapter.tsharvest/claude-adapter.ts`Claude export adapter`harvest/claude-code-adapter.tsharvest/claude-code-adapter.ts`Claude Code session adapter`harvest/gemini-adapter.tsharvest/gemini-adapter.ts`Gemini export adapter`harvest/perplexity-adapter.tsharvest/perplexity-adapter.ts`Perplexity export adapter`harvest/pdf-adapter.tsharvest/pdf-adapter.ts`PDF document adapter`harvest/plaintext-adapter.tsharvest/plaintext-adapter.ts`Plain text adapter`harvest/markdown-adapter.tsharvest/markdown-adapter.ts`Markdown document adapter`harvest/url-adapter.tsharvest/url-adapter.ts`URL/web page adapter`harvest/universal-adapter.tsharvest/universal-adapter.ts`Universal format adapter

### Utilities

Waggle OS sourcehive-mind targetWhat it does`logger.tssrc/logger.ts`Structured logger (createCoreLogger)`config.tssrc/config.ts`Configuration loader`migration.tssrc/migration.ts`Schema migration runner

## Extracted to `@hive-mind/wiki-compiler`

Waggle OS sourcehive-mind targetWhat it does`@waggle/wiki-compiler/src/compiler.tssrc/compiler.ts`Wiki compilation engine`@waggle/wiki-compiler/src/synthesizer.tssrc/synthesizer.ts`LLM-powered synthesis`@waggle/wiki-compiler/src/prompts.tssrc/prompts.ts`Synthesis prompts`@waggle/wiki-compiler/src/state.tssrc/state.ts`Compilation state tracking`@waggle/wiki-compiler/src/types.tssrc/types.ts`Wiki types`@waggle/wiki-compiler/src/index.tssrc/index.ts`Package barrel

## Extracted to `@hive-mind/mcp-server`

Waggle OS sourcehive-mind targetWhat it does`@waggle/memory-mcp/src/index.tssrc/index.ts`MCP server entry point`@waggle/memory-mcp/src/core/setup.tssrc/core/setup.ts`Initialization + shutdown`@waggle/memory-mcp/src/tools/memory.tssrc/tools/memory.ts`recall_memory, save_memory`@waggle/memory-mcp/src/tools/knowledge.tssrc/tools/knowledge.ts`search_entities, add_relation, get_entity`@waggle/memory-mcp/src/tools/identity.tssrc/tools/identity.ts`get_identity, set_identity`@waggle/memory-mcp/src/tools/awareness.tssrc/tools/awareness.ts`get_awareness, set_awareness, clear_awareness`@waggle/memory-mcp/src/tools/workspace.tssrc/tools/workspace.ts`list_workspaces, switch_workspace`@waggle/memory-mcp/src/tools/harvest.tssrc/tools/harvest.ts`harvest_conversations, harvest_status`@waggle/memory-mcp/src/tools/cleanup.tssrc/tools/cleanup.ts`compact_memory, cleanup_deprecated`@waggle/memory-mcp/src/tools/ingest.tssrc/tools/ingest.ts`ingest_source`@waggle/memory-mcp/src/tools/wiki.tssrc/tools/wiki.ts`compile_wiki, search_wiki, get_page, compile_health`@waggle/memory-mcp/src/resources/memory.tssrc/resources/memory.ts`MCP resource definitions

## NOT Extracted (stays in Waggle OS)

These components are proprietary to Waggle OS and are NOT part of hive-mind:

Waggle OS pathWhy it stays`packages/core/src/mind/vault.ts`Secret storage -- Waggle-specific`packages/core/src/compliance/*`EU AI Act compliance layer -- upgrade trigger for Waggle Pro/Teams`packages/core/src/mind/evolution-runs.ts`Self-evolution run store -- Waggle agent feature`packages/core/src/mind/execution-traces.ts`Execution trace store -- Waggle agent feature`packages/core/src/mind/improvement-signals.ts`Improvement signal store -- Waggle agent feature`packages/agent/*`Entire agent runtime -- Waggle-only`packages/shared/src/tiers.ts`Tier/billing system -- Waggle-only`packages/server/*`Fastify sidecar -- Waggle-only`app/*`Tauri desktop shell -- Waggle-only`apps/web/*`Waggle web UI -- Waggle-only

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

- \[ \] Remove all `@waggle/` import paths, replace with `@hive-mind/`
- \[ \] Remove vault.ts dependency (replace with env-var config)
- \[ \] Remove tier-gating checks (everything is free in hive-mind)
- \[ \] Remove telemetry calls (or make opt-in)
- \[ \] Remove compliance hooks
- \[ \] Update data directory from `~/.waggle/` to `~/.hive-mind/`
- \[ \] Add standalone configuration (no Fastify server dependency)
- \[ \] Ensure all SQLite operations use parameterized queries
- \[ \] Replace Waggle-specific logger with standalone pino/winston
- \[ \] Add comprehensive JSDoc for all public APIs
- \[ \] Write tests for all extracted modules (target: 80% coverage)

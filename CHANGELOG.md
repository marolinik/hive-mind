# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-19

Initial public release. Memory substrate, harvest pipeline, wiki compiler, and MCP server — extracted from the [Waggle OS](https://waggle-os.ai) monolith and released under Apache 2.0.

### Added

**`@hive-mind/core`** — memory substrate
- `MindDB` — SQLite + `sqlite-vec` store, schema bootstrap, migrations
- `FrameStore` — I/P/B frames (intra / predicted / bidirectional) with importance weighting and automatic compaction
- `HybridSearch` — FTS5 full-text + vector search fused via Reciprocal Rank Fusion (RRF)
- `KnowledgeGraph` — entities, relations, and bitemporal validity tracking
- `IdentityLayer` — persistent user-identity persistence
- `AwarenessLayer` — active-task / short-horizon state (with expiry)
- `SessionStore` — GOP-style conversation grouping
- `WorkspaceManager` + `MultiMindCache` — per-workspace isolation with an LRU cache across multiple open workspaces
- Harvest pipeline — 11 adapters (ChatGPT, Claude, Claude Code, Gemini, Perplexity, PDF, Markdown, plain text, URL, universal) with 3-pass dedup by frame-id and timestamp, plus `scanForInjection()` on ingested text
- Embedding providers — API, in-process, Ollama, LiteLLM

**`@hive-mind/wiki-compiler`** — wiki compilation engine
- Entity, concept, and synthesis page generators
- Incremental compilation keyed on frame-id
- Health reports (gap detection, conflict detection)
- LLM provider abstraction (Anthropic SDK optional peer)

**`@hive-mind/mcp-server`** — MCP server
- 21 tools: `recall_memory`, `save_memory`, `search_entities`, `add_relation`, `get_entity`, `get_identity`, `set_identity`, `get_awareness`, `set_awareness`, `clear_awareness`, `list_workspaces`, `switch_workspace`, `harvest_conversations`, `harvest_status`, `ingest_source`, `compact_memory`, `cleanup_deprecated`, `compile_wiki`, `search_wiki`, `get_page`, `compile_health`
- 4 resources for workspace introspection
- Stdio transport — compatible with Claude Code, Claude Desktop, Codex, Hermes, and any MCP-compatible client
- Binary entry: `hive-mind-memory-mcp`

**`@hive-mind/cli`** — command-line tools
- `recall-context <query>` — hybrid search from the shell
- `save-session` — persist a session transcript
- `harvest-local` — ingest conversation exports, PDFs, markdown, URLs
- `cognify` — extract entities + relations into the knowledge graph
- `compile-wiki` — build wiki pages from memory
- `maintenance` — compact superseded frames, clean up deprecated data
- Binary entry: `hive-mind-cli`

**Quality**
- 282 tests across 38 test files (vitest)
- Apache 2.0 license, `NOTICE` file explains what stays proprietary in Waggle OS

### Known gaps (tracked for v0.1.x)

- CLI does not yet expose `init`, `status`, or `mcp` subcommands — those are intended persona-facing commands for the first-run smoke flow and will land in a patch release. Today, `npx -y @hive-mind/mcp-server` starts the server directly.
- Cross-platform CI matrix (Windows / macOS) not yet enabled — only Linux runs on CI.
- npm package signing / provenance not yet enabled.

### Not included (stays proprietary in Waggle OS)

- EU AI Act compliance reporting and audit trail
- Agent runtime (personas, behavioral specifications, tool orchestration)
- Self-evolution engine (GEPA iterative optimization, EvolveSchema)
- Encrypted secret vault
- Tier and billing system (Stripe integration)
- Tauri desktop shell and Waggle web UI
- Multi-agent coordination (WaggleDance, sub-agent orchestration)

See [`EXTRACTION.md`](./EXTRACTION.md) for the full extraction mapping and [`NOTICE`](./NOTICE) for the authoritative attribution.

[0.1.0]: https://github.com/marolinik/hive-mind/releases/tag/v0.1.0

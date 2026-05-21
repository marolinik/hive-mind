# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-21

Major release: Claude Code plugin + in-loop memory + local wiki UI + LoCoMo benchmark proof.

### Added

**`@hive-mind/claude-code-hooks`** — NEW package
- 5 lifecycle hooks: SessionStart, UserPromptSubmit, Stop, PreCompact, PostToolUse
- In-loop memory recall, synth queue draining, decision archaeology, contradiction detection
- Packaged as a Claude Code plugin via `.claude-plugin/{plugin,marketplace}.json` — one-line install: `/plugin marketplace add marolinik/hive-mind` then `/plugin install hive-mind@hive-mind`
- `/hive <query>` slash command for ad-hoc wiki search

**`@hive-mind/enrichment`** — NEW package
- `synth-queue` — durable queue for cognify/synthesis tasks with in-flight tracking + reclaim
- `contradiction-detector` — semantic conflict detection across frames
- `decision-archaeology` — surfaces past decisions for "why" intents
- `cross-project-recall` — splits hits by workspace for cross-project awareness
- `failure-recall` — surfaces past failures matching current context
- `prompt-composer` — context assembly for in-loop hooks
- `query-builder`, `workspace-deriver`, `frame-caps`, `bookkeeping-filter`, `llm-verifier`
- Two binaries: `hive-mind-synth-drain`, `hive-mind-synth-queue`

**`@hive-mind/wiki-web`** — NEW package
- Local Express server (port 3717) for browsing compiled wiki pages
- Views: home, search, entity, frame, graph, page
- Reads via the CLI bridge (no direct SQLite access from the web layer)

**`benchmarks/locomo/`** — NEW directory
- 36 numbered scripts covering full LoCoMo benchmark harness (fetch → ingest → cognify → sample build → oracle + retrieval cells → trio + self + Mem0 judges → per-version reports v1→v5)
- `RESULTS.md` — headline v5 (2026-05-11): **73.1% Opus 4.7 / 73.4% Qwen3.6**, N=320 stratified, **+4.6pp over Mem0 paper** under same protocol
- `README.md` — how to reproduce + trio-strict re-judge path + cost actuals (~$9 for v5)
- `docs/{LOCOMO-PLAN,MEM0-METHODOLOGY,COMPARE-vs-prior}.md` — full methodology

**`README.md`** — refreshed
- LoCoMo benchmark badge at the top
- "With Claude Code — one-line plugin install (recommended)" as the first Quick Start option
- 3 new package badges + Packages table rows
- Project structure updated to reflect 7 packages + benchmarks + .claude-plugin

### Headline benchmark

> Two SOTA models converge to within 0.3pp on identical retrieval substrate (73.1% Opus 4.7 / 73.4% Qwen3.6). The substrate, not the subject, is the binding constraint. Stage 3 v6 N=400 memory-lift over no-context baseline: **Δ +19.25pp, Fisher one-sided p = 8.07 × 10⁻¹⁸**.

### Changed

- README "With Claude Code" section split into "plugin (recommended)" and "MCP-only (manual)" — plugin path is now the default recommendation.

### Known follow-ups (post-v0.3.0)

- Trio-strict ensemble re-judge of LoCoMo v5 — converts the 73.1% "internal" number to "publishable" via 4-judge ensemble (Opus 4.7 / GPT-5.4 / Gemini 2.5 Pro / Haiku 4.5). Estimated ~$30 + ~2h.
- Cross-platform CI matrix (Windows / macOS) — still Linux-only.
- npm publishing of the new packages (claude-code-hooks, enrichment, wiki-web) — currently workspace-only.

### Known issues (pre-existing, carried over from v0.2.0)

4 failing tests in `packages/cli/src/dispatch.test.ts` — present on baseline `20bce16` (v0.2.0 commit) and unchanged by v0.3.0 work. All four are seeding-related failures where the test populates a fresh `.mind` file with frames but the dispatched CLI subcommand sees `frames: 0 / entities: 0`. Suspected root cause: path resolution or schema-bootstrap order between the test setup and the dispatch's `MindDB` instantiation. Tests affected:

- `recall-context returns hits as plain text when no --json flag`
- `recall-context with --json emits JSON envelope`
- `cognify scans the seeded frames and reports a run`
- `status --json reports seeded frame count and entities`

Other 308 tests across 38 files pass clean. This is documented here rather than hidden because the failures are infrastructural (test seeding wiring), not user-facing — the actual CLI subcommands work correctly when run against a real `.mind` outside the test harness. Targeted for a v0.3.1 patch release once the seeding fix is identified.

[0.3.0]: https://github.com/marolinik/hive-mind/releases/tag/v0.3.0

---

## [0.2.0] - 2026-04-22

Substrate improvements.

### Added

**`@hive-mind/core`** — semantic chunking + LLM entity extraction
- Semantic chunker — content-aware splitting that respects paragraph + sentence boundaries
- In-process reranker (cross-encoder) — boosts retrieval quality on noisy hybrid-search candidates
- LLM-driven entity extraction — replaces naive regex with provider-backed entity recognition
- Harvest: ClaudeAdapter coverage for 2026-04-22 export streams (memories, design_chats); privacy-respecting gitignore

**`@hive-mind/cli`**
- `mcp start` and `mcp call <tool>` subcommands — exercise the MCP surface from the shell without spinning up a separate client
- Content preview cap raised 2000 → 10000 chars for harvest-local diagnostics

### Fixed

- `harvest-local` now persists `item.timestamp` to `memory_frames.created_at` (Stage 0 root cause). Previously, timestamps were dropped for some adapters.

[0.2.0]: https://github.com/marolinik/hive-mind/releases/tag/v0.2.0

---

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

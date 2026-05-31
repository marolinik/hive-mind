# CLAUDE.md — hive-mind

Guidance for Claude Code agents working **in** or **with** the `hive-mind` repository.

> **hive-mind** is a Local-First AI Memory System: persistent memory, semantic search, a knowledge graph, and a wiki compiler for AI agents. It runs entirely locally with zero cloud dependency.
>
> Repo: https://github.com/marolinik/hive-mind · Default branch: `master` · License: Apache-2.0 · Node >=20.

This is the **hive-mind repo root** CLAUDE.md. A separate, unrelated `/create-spec` CLAUDE.md lives at `D:/Projects/CLAUDE.md` — do not conflate the two, and never modify anything outside `D:/Projects/hive-mind`.

---

## A) Using hive-mind from Claude Code

### Install the plugin (recommended)

```
/plugin marketplace add marolinik/hive-mind
/plugin install hive-mind@hive-mind
```

This wires up everything below. Manifest: `.claude-plugin/plugin.json`; marketplace: `.claude-plugin/marketplace.json`.

### What you get

**21 MCP tools**, auto-registered and namespaced as `mcp__hive-mind__<tool>` (e.g. `mcp__hive-mind__recall_memory`):

| Group | Tools |
|-------|-------|
| Memory | `recall_memory`, `save_memory` |
| Knowledge | `search_entities`, `save_entity`, `create_relation` |
| Identity | `get_identity`, `set_identity` |
| Awareness | `get_awareness`, `set_awareness`, `clear_awareness` |
| Workspace | `list_workspaces`, `create_workspace` |
| Harvest | `harvest_sources`, `harvest_import` |
| Ingest | `ingest_source` |
| Cleanup | `cleanup_frames`, `cleanup_entities` |
| Wiki | `compile_wiki`, `search_wiki`, `get_page`, `compile_health` |

These are the authoritative tool names (from `packages/mcp-server/src/tools/*.ts`). The README "MCP Tools Reference" table is stale — trust this list, not the README.

**5 lifecycle hooks** (`packages/claude-code-hooks/hooks/`, with a shared `_shared.js` helper):

| File | Trigger event | Purpose |
|------|---------------|---------|
| `session-start.js` | `SessionStart` | Loads identity/awareness + recent context at session open |
| `user-prompt-submit.js` | `UserPromptSubmit` | Recall-before: injects memory relevant to the prompt |
| `stop.js` | `Stop` | Save-after: persists salient frames; drains the synth queue |
| `pre-compact.js` | `PreCompact` | Preserves context before compaction |
| `post-tool-use.js` | `PostToolUse` | Decision archaeology + contradiction detection on the fly |

**`/hive <query>` slash command** (`packages/claude-code-hooks/commands/hive.md`): ad-hoc lookup that calls `search_wiki` (limit 5) + `recall_memory` (limit 8, scope `all`, profile `balanced`), returning matching wiki pages plus recent frames inline.

### In-loop memory protocol (automated by the hooks)

You do not need to manually call memory tools in normal use — the hooks run it for you:

- **Recall on `UserPromptSubmit`** — `user-prompt-submit.js` pulls memory relevant to the incoming prompt before you respond.
- **Save on `Stop`** — `stop.js` persists the salient frames from the turn and drains the synthesis queue.
- **Preserve on `PreCompact`** and **decision/contradiction capture on `PostToolUse`** round out the loop.

Use `/hive <query>` for explicit, on-demand recall, or call the `mcp__hive-mind__*` tools directly when you need finer control.

### MCP-only manual alternative (no plugin)

If you don't want the plugin (and therefore no hooks or `/hive`), register the MCP server directly. Add this to your Claude Code `settings.json`:

```json
{
  "mcpServers": {
    "hive-mind": {
      "command": "npx",
      "args": ["@hive-mind/mcp-server"]
    }
  }
}
```

The server speaks **stdio**, registers internally as `hive-mind-memory`, and exposes the same 21 tools. Data lives in a single-file SQLite DB per mind (`*.mind`) under `HIVE_MIND_DATA_DIR` (default `~/.hive-mind`).

---

## B) Developing hive-mind

### Repo layout — 7 packages (all `@hive-mind/*`)

| Package | Role |
|---------|------|
| `core` | Engine: `MindDB`, `FrameStore`, `HybridSearch`, `KnowledgeGraph`, `IdentityLayer`, `AwarenessLayer`, `SessionStore`, harvest pipeline |
| `wiki-compiler` | Compiles frames/entities into navigable wiki pages |
| `mcp-server` | stdio MCP server exposing the 21 tools (`npx @hive-mind/mcp-server`) |
| `cli` | Commands: `recall-context`, `save-session`, `harvest-local`, `cognify`, `compile-wiki`, `maintenance` |
| `claude-code-hooks` | The 5 lifecycle hooks + `/hive` command + `_shared.js` |
| `enrichment` | Enrichment/synthesis utilities over stored frames |
| `wiki-web` | Local Express server on port **3717** for browsing wiki pages, entity graphs, frame timelines |

### Dev commands

```bash
npm install        # bootstrap the workspace
npm run build      # tsc --build (TypeScript project references)
npm test           # vitest run (current suite: 312 green)
npm run lint       # eslint . (flat config, deliberately light tier)
npm run typecheck  # tsc --build
npm run clean      # clear build artifacts
```

`npm test`, `npm run build`, `npm run typecheck`, and `npm run lint` are all real CI gates — none are silently skipped.

### Conventions

- **npm workspaces** for the monorepo. Do **not** introduce pnpm or Turborepo — that migration is explicitly deferred.
- **TypeScript project references** (`tsc --build`); respect the per-package `tsconfig` graph.
- **vitest** for tests; aim to keep the suite green.
- **eslint** flat config (`eslint.config.js`), deliberately light and non-type-checked; it ignores `dist/`, `benchmarks/`, and the `wiki-web` frontend.
- **Conventional commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`).
- **Branch from `master`**; open PRs against `master`.
- Follow the existing code style: many small focused files, immutable data patterns, explicit error handling, no hardcoded secrets (provider API keys come from env, never the DB).

### Key concepts (for code that touches the engine)

- **I/P/B frames** — `I` (Intra) = Fact (self-contained); `P` (Predicted) = Hypothesis (agent-inferred, may reference an I-frame); `B` (Bidirectional) = Correction (updates an I/P). Frames are grouped into **GOPs** (Group of Pictures) per session. Importance weights: critical 2.0, important 1.5, normal 1.0, temporary 0.7, deprecated 0.3.
- **HybridSearch** — FTS5 (BM25 keyword) + vector (sqlite-vec, cosine) fused via Reciprocal Rank Fusion (RRF), then scored by recency / importance / access-frequency.
- **Harvest** — 10 adapters: ChatGPT, Claude, Claude Code, Gemini, Perplexity, PDF, Markdown, plain text, URL, plus a universal adapter.
- **Prompt-injection scanner** — `scanForInjection(text, context)` in `packages/core/src/injection-scanner.ts`; flags role-override / prompt-extraction / authority-claim patterns with a score.

### Environment variables

Core: `HIVE_MIND_DATA_DIR`, `HIVE_MIND_EMBEDDING_PROVIDER`, `HIVE_MIND_ROOT` (portable benchmark root), `HIVE_MIND_NO_SYNTH`, `HIVE_MIND_CONTRADICTION_OFF`, `HIVE_MIND_NO_RERANK` (skip the ~87MB ONNX reranker load — for CI/headless/low-resource), `HIVE_MIND_TIER`, `HIVE_MIND_CLI`, `HIVE_MIND_SQLITE_VEC_PATH`.

Verify: `HIVE_MIND_VERIFY_LLM`, `HIVE_MIND_VERIFY_MODEL`, `HIVE_MIND_VERIFY_THRESHOLD`.

Cognify: `HIVE_MIND_COGNIFY_EXTRACTOR`, `HIVE_MIND_COGNIFY_EXECUTOR`, `HIVE_MIND_COGNIFY_NO_SINGLE_WORD`.

Embedding-provider keys (read from env, never stored): `OPENAI_API_KEY` / `OPENAI_MODEL`, `VOYAGE_API_KEY` / `VOYAGE_MODEL`, `OLLAMA_URL` / `OLLAMA_MODEL`. (`ANTHROPIC_API_KEY` is used by the wiki synthesizer (Haiku) and LLM-based cognify extraction, **not** for embeddings.)

### Library usage (using `@hive-mind/core` directly)

```ts
const db = new MindDB('~/.hive-mind/x.mind');
const frames = new FrameStore(db);
const search = new HybridSearch(db);
const graph = new KnowledgeGraph(db);
```

### Sync to Waggle OS

`packages/cli/**` and `core` sync **upstream** to Waggle OS — keep them portable and free of host-specific assumptions (no hardcoded absolute paths). See `EXTRACTION.md` for the extraction boundary and what stays proprietary in Waggle OS (compliance layer, agent runtime/personas, self-evolution, encrypted vault, tier/billing, Tauri shell, multi-agent coordination). CI: `.github/workflows/ci.yml` (build + test + lint + typecheck) and `sync-to-waggle-os.yml`.

# Architecture

hive-mind is a local-first AI memory system: persistent memory, semantic search,
a bitemporal knowledge graph, and a wiki compiler — all running locally over a
single-file SQLite database with zero cloud dependency by default.

This document explains the system in depth. The [README](../README.md) carries
the same diagrams in brief; here we walk through what they mean.

## High-Level Components

```
                         MCP Clients
                  (Claude Code / Codex / Hermes)
                             |
                      stdio transport
                             |
                    +------------------+
                    |   MCP Server     |  @hive-mind/mcp-server
                    |   (21 tools)     |  recall, save, search, harvest,
                    +------------------+  wiki, identity, awareness, ...
                             |
              +--------------+--------------+
              |                             |
   +-------------------+         +--------------------+
   |   Core Substrate  |         |   Wiki Compiler    |  @hive-mind/wiki-compiler
   |                   |         |                    |
   |  FrameStore (I/P/B)         |  Entity pages      |
   |  HybridSearch     |         |  Concept pages     |
   |  KnowledgeGraph   |         |  Synthesis pages   |
   |  IdentityLayer    |         |  Health reports    |
   |  AwarenessLayer   |         +--------------------+
   |  SessionStore     |
   |  Harvest Pipeline |  @hive-mind/core
   +-------------------+
              |
     +--------+--------+
     |                  |
  SQLite DB        Embeddings
  (single file)    (API / Ollama /
                    in-process)
```

Any MCP-compatible client (Claude Code, Codex, Hermes) talks to the **MCP server**
over **stdio**. The server exposes **21 tools** and delegates to two consumers of
the core substrate: the **core** package (everything memory) and the
**wiki-compiler** (knowledge-page generation). Both read and write a single SQLite
file, with vectors stored alongside via sqlite-vec. Embeddings are produced by a
pluggable provider.

## Packages

Seven packages, all scoped `@hive-mind/*`. **`core` is the substrate**; everything
else consumes it.

```
                 +---------------------+
                 |  @hive-mind/core    |   substrate (no internal deps)
                 +----------+----------+
                            ^
        +----------+--------+--------+-----------+-------------+
        |          |                 |           |             |
  wiki-compiler  mcp-server        cli      claude-code-hooks  enrichment
        ^                                                       ^
        |                                                       |
     wiki-web                                          (composed by hooks)
```

| Package | Depends on | Role |
|---|---|---|
| [`@hive-mind/core`](../packages/core) | — | Memory substrate: MindDB, FrameStore, HybridSearch, KnowledgeGraph, IdentityLayer, AwarenessLayer, SessionStore, Harvest pipeline. |
| [`@hive-mind/wiki-compiler`](../packages/wiki-compiler) | core | Compiles memory frames into interlinked wiki pages with LLM synthesis. |
| [`@hive-mind/mcp-server`](../packages/mcp-server) | core, wiki-compiler | MCP server exposing all 21 tools to any MCP client over stdio. |
| [`@hive-mind/cli`](../packages/cli) | core, wiki-compiler | CLI: `recall-context`, `save-session`, `harvest-local`, `cognify`, `compile-wiki`, `maintenance`. |
| [`@hive-mind/claude-code-hooks`](../packages/claude-code-hooks) | core, enrichment | 5 Claude Code lifecycle hooks for in-loop memory + synth-queue draining + decision archaeology / contradiction detection. |
| [`@hive-mind/enrichment`](../packages/enrichment) | core | Synth queue, contradiction detector, decision archaeology, cross-project recall, failure recall, prompt composer, LLM verifier. |
| [`@hive-mind/wiki-web`](../packages/wiki-web) | core | Local Express server (port 3717) for browsing compiled wiki pages, entity graphs, frame timelines. |

The monorepo uses **npm workspaces** with **TypeScript project references**
(`tsc --build`); tests run on **vitest**.

## Core Substrate Internals

`@hive-mind/core` is a set of cohesive stores layered over one SQLite database.
Public exports: `MindDB`, `FrameStore`, `HybridSearch`, `KnowledgeGraph`,
`IdentityLayer`, `AwarenessLayer`, `SessionStore`, plus the Harvest pipeline.

- **MindDB** — owns the SQLite connection (better-sqlite3 + sqlite-vec), schema,
  and migrations. One `MindDB` instance per `.mind` file.
- **FrameStore** — the memory table. Stores **I/P/B** frames (see below), handles
  dedup, compaction, and writes both the FTS5 index and the vector table on save.
- **HybridSearch** — query path. Runs FTS5 keyword search and vector similarity in
  parallel, fuses with **Reciprocal Rank Fusion (RRF)**, then re-scores.
- **KnowledgeGraph** — entities and relations with **bitemporal validity** (each
  fact tracks both when it was true and when it was recorded), so the graph can be
  queried as-of any point in time.
- **IdentityLayer** — durable personal identity (who the user is, hard rules).
- **AwarenessLayer** — active tasks and current state, with expiry.
- **SessionStore** — manages GOP (Group of Pictures) sessions that group frames.
- **Harvest pipeline** — ingestion orchestrator feeding **10 adapters** (ChatGPT,
  Claude, Claude Code, Gemini, Perplexity, PDF, Markdown, plain text, URL, plus a
  universal adapter), with dedup and source tracking.

Library usage:

```ts
import { MindDB, FrameStore, HybridSearch, KnowledgeGraph } from '@hive-mind/core';

const db = new MindDB('~/.hive-mind/x.mind');
const frames = new FrameStore(db);
const search = new HybridSearch(db);
const graph = new KnowledgeGraph(db);
```

## Data Flow

```
Harvest Sources          Memory Storage              Knowledge Output
+-----------+     +----+     +-----------+     +----+     +-----------+
| ChatGPT   |     |    |     | FrameStore|     |    |     | Wiki      |
| Claude    -+---->|Pipe|--->| (I/P/B)   +---->|Wiki|--->| Pages     |
| Gemini    |     |line |     | + FTS5    |     |Comp|     | + Health  |
| PDF / URL |     |    |     | + vec0    |     |iler|     | Report    |
| Markdown  |     +----+     +-----------+     +----+     +-----------+
+-----------+           |           |
                        v           v
                  +-----------+  +-----------+
                  | Knowledge |  | Identity  |
                  | Graph     |  | + Aware-  |
                  | (entities,|  |   ness    |
                  |  relations)|  +-----------+
                  +-----------+
```

1. **Harvest** — conversation exports and documents enter through the harvest
   pipeline (or `ingest_source` for a single document/URL/file).
2. **Store** — the pipeline writes **I/P/B frames** into FrameStore. Each save also
   populates the **FTS5** index and the **vec0** vector table.
3. **Derive** — extracted entities and relations populate the **KnowledgeGraph**;
   identity and awareness signals update the **IdentityLayer** / **AwarenessLayer**.
4. **Compile** — the **wiki-compiler** reads frames + graph and emits interlinked
   **wiki pages** (entity / concept / synthesis) and **health reports**.

## Memory Model: I/P/B Frames

Memory is modeled after a video codec's frame types.

| Frame | Name | Purpose |
|---|---|---|
| **I** (Intra) | Fact | Self-contained factual statement; no dependencies. |
| **P** (Predicted) | Hypothesis | Agent-inferred knowledge; may reference an I-frame as its base. |
| **B** (Bidirectional) | Correction | Updates or corrects an existing I or P frame. |

Frames are grouped into **GOPs (Group of Pictures)** per conversation session.
**Compaction** merges superseded frames so the store stays lean while preserving an
audit trail (corrections demote, they do not delete).

### Importance Weights

Every frame carries an importance level that scales its search score:

| Level | Weight | Use case |
|---|---|---|
| `critical` | 2.0 | Core identity, hard constraints, user-stated rules. |
| `important` | 1.5 | Preferences, recurring patterns, project decisions. |
| `normal` | 1.0 | General facts, observations. |
| `temporary` | 0.7 | Session-local context; decays. |
| `deprecated` | 0.3 | Superseded by a correction; kept for audit. |

## Search Pipeline

`HybridSearch` fuses two retrieval strategies, then re-ranks:

1. **FTS5 full-text** — keyword matching via SQLite FTS5 with **BM25** ranking.
2. **Vector similarity** — semantic search via **sqlite-vec** (cosine similarity)
   over embeddings.

The two ranked lists are combined with **Reciprocal Rank Fusion (RRF)**, then scored
by a composite that factors **recency**, **importance** (weights above), and
**access frequency**. Scoring profiles (e.g. `balanced`) tune these factors.

## Storage

- **One SQLite file per mind** (`*.mind`), opened by `MindDB`. There is no separate
  server process for the database — it is embedded.
- **Vectors live in the same file** via the **sqlite-vec** extension (`vec0`
  virtual table), so memory and embeddings stay in one portable artifact.
- **Data directory** is set by `HIVE_MIND_DATA_DIR` (default `~/.hive-mind`).
- **Workspace isolation** — multiple workspaces give separate memory spaces (e.g.
  per project); list or create them via the workspace tools (`list_workspaces` /
  `create_workspace`), and target one by passing its `workspace` id on memory calls.
  (There is no "switch" tool — selection is per-call.)

```bash
export HIVE_MIND_DATA_DIR="$HOME/.hive-mind"   # default
# each mind is a single file, e.g.  ~/.hive-mind/default.mind
```

The vector extension path can be overridden with `HIVE_MIND_SQLITE_VEC_PATH`.

## Embedding Providers

Embeddings are pluggable behind a provider interface, selected by
`HIVE_MIND_EMBEDDING_PROVIDER`:

| Provider | Description | Relevant env |
|---|---|---|
| API | Hosted embedding APIs (OpenAI, Voyage). | `OPENAI_API_KEY` / `OPENAI_MODEL`, `VOYAGE_API_KEY` / `VOYAGE_MODEL` |
| In-process | Local in-process embedder; no network. | — |
| Ollama | Local Ollama embedding models. | `OLLAMA_URL`, `OLLAMA_MODEL` |
| LiteLLM | LiteLLM proxy front-end to many providers. | (LiteLLM config) |

Provider API keys are read from the environment and **never stored in the database**.
`ANTHROPIC_API_KEY` is *not* an embedding key — it configures the wiki synthesizer (Haiku)
and LLM-based cognify extraction (see the Wiki Compiler section), not vector embeddings.
The in-process and Ollama providers keep embedding fully local, preserving the
local-first, zero-egress posture.

```bash
export HIVE_MIND_EMBEDDING_PROVIDER=ollama
export OLLAMA_URL=http://localhost:11434
export OLLAMA_MODEL=nomic-embed-text
```

## The 21 MCP Tools

The MCP server (internal name `hive-mind-memory`) launches via
`npx @hive-mind/mcp-server` over stdio and exposes 21 tools. In Claude Code they are
namespaced as `mcp__hive-mind__<tool>`.

| Category | Tools |
|---|---|
| Memory | `recall_memory`, `save_memory` |
| Knowledge | `search_entities`, `save_entity`, `create_relation` |
| Identity | `get_identity`, `set_identity` |
| Awareness | `get_awareness`, `set_awareness`, `clear_awareness` |
| Workspace | `list_workspaces`, `create_workspace` |
| Harvest | `harvest_sources`, `harvest_import` |
| Ingest | `ingest_source` |
| Cleanup | `cleanup_frames`, `cleanup_entities` |
| Wiki | `compile_wiki`, `search_wiki`, `get_page`, `compile_health` |

## Extraction Boundary

hive-mind is extracted from the larger **Waggle OS** monorepo. The full mapping of
which source files become which hive-mind package — and which intentionally stay
proprietary — is tracked in [EXTRACTION.md](../EXTRACTION.md).

What **stays in Waggle OS** (not part of hive-mind): the EU AI Act compliance layer,
the agent runtime / personas, self-evolution (GEPA / EvolveSchema), the encrypted
vault, tier / billing (Stripe), the Tauri desktop shell, and multi-agent coordination
(WaggleDance). hive-mind is the open memory substrate; those layers build on top of it
in the commercial product.

## Security Posture

- **Local-first** — no cloud data egress by default; everything runs against the
  local `.mind` file.
- **Prompt-injection scanning** — `scanForInjection(text, context)` in
  [`packages/core/src/injection-scanner.ts`](../packages/core/src/injection-scanner.ts)
  flags role-override, prompt-extraction, and authority-claim patterns with a score.
- **Secrets** — provider API keys are read from environment variables only and are
  never persisted to the database.

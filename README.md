# hive-mind -- Local-First AI Memory System

[![CI](https://github.com/egzakta/hive-mind/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/egzakta/hive-mind/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm: core](https://img.shields.io/npm/v/@hive-mind/core.svg?label=%40hive-mind%2Fcore)](https://www.npmjs.com/package/@hive-mind/core)
[![npm: wiki-compiler](https://img.shields.io/npm/v/@hive-mind/wiki-compiler.svg?label=%40hive-mind%2Fwiki-compiler)](https://www.npmjs.com/package/@hive-mind/wiki-compiler)
[![npm: mcp-server](https://img.shields.io/npm/v/@hive-mind/mcp-server.svg?label=%40hive-mind%2Fmcp-server)](https://www.npmjs.com/package/@hive-mind/mcp-server)
[![npm: cli](https://img.shields.io/npm/v/@hive-mind/cli.svg?label=%40hive-mind%2Fcli)](https://www.npmjs.com/package/@hive-mind/cli)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-green.svg)](https://modelcontextprotocol.io)

Persistent memory, semantic search, knowledge graph, and wiki compiler for AI agents.
Runs locally. Zero cloud dependency.

---

## Features

- **21 MCP tools** -- plug into Claude Code, Codex, Hermes, or any MCP-compatible client
- **11 harvest adapters** -- ingest from ChatGPT, Claude, Claude Code, Gemini, Perplexity, PDF, Markdown, plain text, URL, and universal formats
- **FTS5 + vector hybrid search** -- full-text and semantic search fused via Reciprocal Rank Fusion
- **Knowledge graph** -- entities, relations, and bitemporal validity tracking
- **I/P/B memory frames** -- intra-frame (facts), predicted-frame (hypotheses), bidirectional-frame (corrections) with automatic compaction
- **Wiki compiler** -- synthesize memory frames into interlinked wiki pages using any LLM
- **Identity and awareness layers** -- persistent user identity and active task/state tracking
- **Session management** -- group memories by conversation with GOP (Group of Pictures) organization
- **Multiple embedding providers** -- API, in-process, Ollama, LiteLLM
- **SQLite-backed** -- single-file database, zero infrastructure, instant backups
- **Workspace isolation** -- separate memory spaces per project

## Quick Start

### With Claude Code

Add to your `~/.claude/settings.json`:

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

### With Claude Desktop

Add to your `claude_desktop_config.json`:

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

### With Codex

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

### With Hermes or any MCP client

```bash
npx @hive-mind/mcp-server
```

The server communicates via stdio, compatible with any MCP client implementation.

### As a library

```bash
npm install @hive-mind/core
```

```typescript
import { MindDB, FrameStore, HybridSearch, KnowledgeGraph } from '@hive-mind/core';

const db = new MindDB('~/.hive-mind/my-project.mind');
const frames = new FrameStore(db);
const search = new HybridSearch(db);
const kg = new KnowledgeGraph(db);

// Save a memory
frames.insert({
  frame_type: 'I',
  content: 'User prefers TypeScript over JavaScript',
  importance: 'important',
  source: 'user_stated',
});

// Search with hybrid FTS5 + vector
const results = await search.query('programming language preferences');

// Explore the knowledge graph
const entities = kg.searchEntities('TypeScript');
```

## Architecture

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

### Data Flow

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

## Packages

| Package | Description |
|---|---|
| [`@hive-mind/core`](packages/core) | Memory substrate: FrameStore, HybridSearch, KnowledgeGraph, IdentityLayer, AwarenessLayer, Harvest pipeline |
| [`@hive-mind/wiki-compiler`](packages/wiki-compiler) | Compile memory frames into interlinked wiki pages with LLM synthesis |
| [`@hive-mind/mcp-server`](packages/mcp-server) | MCP server exposing all 21 tools for any MCP-compatible AI client |
| [`@hive-mind/cli`](packages/cli) | Command-line tools: `recall-context`, `save-session`, `harvest-local`, `cognify`, `compile-wiki`, `maintenance` |

## Memory Model: I/P/B Frames

hive-mind organizes memory using a video-codec-inspired frame model:

| Frame type | Name | Purpose |
|---|---|---|
| **I** (Intra) | Fact | Standalone factual statements. Self-contained, no dependencies. |
| **P** (Predicted) | Hypothesis | Agent-inferred knowledge. May reference an I-frame as its base. |
| **B** (Bidirectional) | Correction | Corrections or updates to existing I or P frames. |

Frames are organized into GOPs (Group of Pictures) per conversation session.
Automatic compaction merges superseded frames to keep the store lean.

### Importance Levels

| Level | Weight | Use case |
|---|---|---|
| `critical` | 2.0x | Core identity, hard constraints, user-stated rules |
| `important` | 1.5x | Preferences, recurring patterns, project decisions |
| `normal` | 1.0x | General facts, observations |
| `temporary` | 0.5x | Session-local context, will decay |
| `deprecated` | 0.0x | Superseded by corrections, kept for audit trail |

## Search Pipeline

HybridSearch combines two search strategies using Reciprocal Rank Fusion (RRF):

1. **FTS5 full-text search** -- keyword matching with SQLite FTS5, BM25 ranking
2. **Vector similarity search** -- semantic search using sqlite-vec with cosine similarity

Results are fused with configurable weights and ranked by a composite score that
factors in recency, importance, and access frequency.

## MCP Tools Reference

| Tool | Category | Description |
|---|---|---|
| `recall_memory` | Memory | Search memory with hybrid FTS5 + vector |
| `save_memory` | Memory | Persist a new memory frame |
| `search_entities` | Knowledge | Search the knowledge graph |
| `add_relation` | Knowledge | Add an entity relation |
| `get_entity` | Knowledge | Get entity details and relations |
| `get_identity` | Identity | Retrieve stored user identity |
| `set_identity` | Identity | Update user identity fields |
| `get_awareness` | Awareness | Get active tasks and state |
| `set_awareness` | Awareness | Set an awareness item |
| `clear_awareness` | Awareness | Clear expired/completed items |
| `list_workspaces` | Workspace | List available memory workspaces |
| `switch_workspace` | Workspace | Switch to a different workspace |
| `harvest_conversations` | Harvest | Ingest AI conversation exports |
| `harvest_status` | Harvest | Check harvest pipeline status |
| `ingest_source` | Ingest | Ingest a document, URL, or file |
| `compact_memory` | Cleanup | Compact superseded frames |
| `cleanup_deprecated` | Cleanup | Remove deprecated frames |
| `compile_wiki` | Wiki | Compile memory into wiki pages |
| `search_wiki` | Wiki | Search compiled wiki pages |
| `get_page` | Wiki | Retrieve a specific wiki page |
| `compile_health` | Wiki | Check data quality and find gaps |

## Wiki Compiler

The wiki compiler transforms raw memory frames into structured, interlinked knowledge pages:

- **Entity pages** -- one page per significant entity (person, project, technology)
- **Concept pages** -- synthesized pages for abstract concepts and themes
- **Synthesis pages** -- cross-cutting pages that connect related entities and concepts
- **Health reports** -- data quality analysis identifying gaps and inconsistencies

Compilation is incremental: only new or modified frames trigger recompilation.
Synthesis uses any LLM provider (OpenAI, Anthropic, Ollama, LiteLLM).

## What Stays in Waggle OS

hive-mind is the open-source memory engine extracted from [Waggle OS](https://waggle-os.ai).
The following components are NOT part of hive-mind and remain proprietary:

- **Compliance layer** -- EU AI Act compliance reporting and audit trails
- **Agent runtime** -- LLM agent loop, personas, behavioral specs
- **Self-evolution** -- GEPA iterative optimization and EvolveSchema
- **Vault** -- encrypted secret storage
- **Tier/billing system** -- Stripe integration, feature gating
- **Desktop shell** -- Tauri 2.0 application, workspace UI
- **Multi-agent coordination** -- WaggleDance, subagent orchestration

If you need these capabilities, check out [Waggle OS](https://waggle-os.ai) or
[KVARK](https://www.kvark.ai) for enterprise deployments.

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Clean build artifacts
npm run clean
```

### Project structure

```
hive-mind/
  packages/
    core/           # Memory substrate + harvest pipeline
    wiki-compiler/  # Wiki compilation engine
    mcp-server/     # MCP server (21 tools)
  EXTRACTION.md     # Mapping from Waggle OS source
```

## Contributing

Contributions are welcome. Please see the following guidelines:

1. **Fork and branch** -- create a feature branch from `master` (the default branch)
2. **Test** -- ensure `npm test` passes with 80%+ coverage
3. **Lint** -- run `npm run lint` before submitting
4. **Conventional commits** -- use `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
5. **One concern per PR** -- keep pull requests focused

For major changes, open an issue first to discuss the approach.

## License

[Apache License 2.0](LICENSE) -- Copyright 2026 Egzakta Group d.o.o.

---

Built by [Egzakta Group](https://egzakta.com) | [Waggle OS](https://waggle-os.ai) | [KVARK](https://www.kvark.ai)

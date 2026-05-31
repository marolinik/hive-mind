# AGENTS.md — hive-mind for any AI agent

Universal, tool-agnostic integration guide for **any** AI agent or coding harness:
Claude Code, Codex, Cursor, Hermes, OpenClaw, custom MCP clients. If you are running
**Claude Code specifically**, the plugin/hook/slash-command setup lives in
[`CLAUDE.md`](./CLAUDE.md) and [`docs/INTEGRATIONS.md`](./docs/INTEGRATIONS.md) — this
file deliberately does not duplicate that.

hive-mind is a **local-first AI memory system**: persistent memory, semantic search,
a knowledge graph, and a wiki compiler. It runs locally over SQLite — zero cloud
dependency. Provider API keys (if you use API-based embeddings) are read from env and
never stored in the database.

---

## 1. What hive-mind gives an agent

- **Persistent cross-session memory** — facts, decisions, and preferences survive across
  conversations as I/P/B frames (see §6), grouped into per-session GOPs.
- **Hybrid search** — FTS5 (BM25 keyword) + vector (sqlite-vec, cosine) fused via
  Reciprocal Rank Fusion (RRF), then scored with recency, importance, and access frequency.
- **Knowledge graph** — entities + relations with bitemporal validity, explorable from tools.
- **Wiki** — synthesize raw frames into interlinked wiki pages you can search and read.

---

## 2. One-line start

Launch the MCP server over **stdio**:

```bash
npx @hive-mind/mcp-server
```

Generic client config (works for any MCP-compatible harness):

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

Internal server name: `hive-mind-memory`. Requires Node >= 20. In Claude Code, tools are
namespaced as `mcp__hive-mind__<tool>` (e.g. `mcp__hive-mind__recall_memory`).

---

## 3. The 21 MCP tools

Exact names as registered in `packages/mcp-server/src/tools/*.ts`.

| Tool | Category | What it does |
|------|----------|--------------|
| `recall_memory`    | Memory    | Hybrid-search recall of relevant memories for a query/context. |
| `save_memory`      | Memory    | Persist a fact/decision/preference/context; auto-indexed for search. |
| `search_entities`  | Knowledge | Search the knowledge graph for entities. |
| `save_entity`      | Knowledge | Create or update an entity in the graph. |
| `create_relation`  | Knowledge | Link two entities with a typed relation. |
| `get_identity`     | Identity  | Read the persistent user identity profile. |
| `set_identity`     | Identity  | Update the user identity profile. |
| `get_awareness`    | Awareness | Read current active task/state context. |
| `set_awareness`    | Awareness | Set current active task/state context. |
| `clear_awareness`  | Awareness | Clear the active task/state context. |
| `list_workspaces`  | Workspace | List isolated memory workspaces. |
| `create_workspace` | Workspace | Create a new isolated memory workspace. |
| `harvest_sources`  | Harvest   | Discover importable conversation/source files. |
| `harvest_import`   | Harvest   | Import discovered sources into memory. |
| `ingest_source`    | Ingest    | Add a document, URL, or file to memory. |
| `cleanup_frames`   | Cleanup   | Prune/compact memory frames. |
| `cleanup_entities` | Cleanup   | Prune stale/orphaned graph entities. |
| `compile_wiki`     | Wiki      | Synthesize memory frames into wiki pages via an LLM. |
| `search_wiki`      | Wiki      | Search compiled wiki pages. |
| `get_page`         | Wiki      | Fetch a single compiled wiki page. |
| `compile_health`   | Wiki      | Report data quality and surface knowledge gaps. |

> Note: names that may appear in older docs or cached references (e.g. `add_relation`,
> `get_entity`, `switch_workspace`, `harvest_conversations`, `compact_memory`) are **not**
> real tools — use the names above.

---

## 4. Recommended agent protocol

A simple, durable loop any harness can adopt:

1. **At task start — `recall_memory` FIRST.** Pull relevant prior context before doing
   anything. Cheap, and it prevents re-deriving known facts or contradicting past decisions.
2. **For user context — `get_identity` and `get_awareness`.** Identity = who the user is and
   their durable preferences; awareness = what they're actively working on right now.
3. **Explore the graph — `search_entities`.** When a task touches named things
   (people, projects, systems), look them up to ground your answer.
4. **Use synthesized knowledge — `search_wiki` / `get_page`.** For "what do we know about X"
   questions, the compiled wiki is denser than raw frames. Run `compile_wiki` to (re)build it,
   `compile_health` to find gaps.
5. **Add documents — `ingest_source`.** Pull a PDF, URL, markdown, or text file into memory
   so it becomes searchable/recallable.
6. **For durable facts/decisions/preferences — `save_memory`.** Persist anything worth
   remembering next session. Be specific; set `importance` (see §6) and `source`.
7. **Maintain context — `set_awareness` / `clear_awareness`** as the active task changes;
   `save_entity` + `create_relation` to grow the graph.

Rule of thumb: **recall before you reason, save after you decide.**

---

## 5. Key environment variables

| Var | Purpose |
|-----|---------|
| `HIVE_MIND_DATA_DIR` | Data directory (default `~/.hive-mind`). One single-file SQLite DB per mind (`*.mind`). |
| `HIVE_MIND_EMBEDDING_PROVIDER` | Select the embedding backend. |

Embedding-provider keys (only what your chosen provider needs):

```bash
OPENAI_API_KEY=...      # + OPENAI_MODEL
VOYAGE_API_KEY=...      # + VOYAGE_MODEL
OLLAMA_URL=...          # + OLLAMA_MODEL  (local, no key)
```

(`ANTHROPIC_API_KEY` is **not** an embedding key — it powers the wiki synthesizer and LLM-based cognify extraction. Embedding providers are `openai`, `voyage`, `ollama`, and the in-process backend.)

Local-first default: with a local embedding provider (e.g. Ollama) there is **no cloud egress**.

---

## 6. Memory model: I/P/B frames + importance

| | | |
|---|---|---|
| **I — Intra (Fact)** | self-contained, standalone truth | "User prefers TypeScript strict mode." |
| **P — Predicted (Hypothesis)** | agent-inferred; may reference an I-frame | "Likely wants the same lint config in new repos." |
| **B — Bidirectional (Correction)** | updates/supersedes an I- or P-frame | "Actually, JS not TS for this project." |

Frames are organized into **GOPs** (Group of Pictures) per session.

| Importance | Weight |
|------------|--------|
| `critical`   | 2.0 |
| `important`  | 1.5 |
| `normal`     | 1.0 |
| `temporary`  | 0.7 |
| `deprecated` | 0.3 |

`save_memory` accepts `importance` of `critical` / `important` / `normal` / `temporary`
(the `deprecated` weight 0.3 is used internally for retired frames).

---

## 7. Workspaces = isolated memory spaces

A **workspace** is a separate memory space — use one per project so a project's frames,
entities, and wiki don't bleed into personal memory or another project. Omit the workspace
to use personal memory. List with `list_workspaces`, create with `create_workspace`, and pass
the workspace id to memory tools (e.g. `save_memory`'s `workspace` argument) to scope writes.

---

## 8. Beyond MCP

- **Library** (`@hive-mind/core`): `MindDB`, `FrameStore`, `HybridSearch`, `KnowledgeGraph`,
  `IdentityLayer`, `AwarenessLayer`, `SessionStore`, plus the Harvest pipeline.
  ```ts
  const db = new MindDB('~/.hive-mind/x.mind');
  const frames = new FrameStore(db);
  const search = new HybridSearch(db);
  const graph = new KnowledgeGraph(db);
  ```
- **CLI** (`@hive-mind/cli`): `recall-context`, `save-session`, `harvest-local`, `cognify`,
  `compile-wiki`, `maintenance`.
- **Wiki web UI** (`@hive-mind/wiki-web`): local Express server on port **3717** for browsing
  compiled wiki pages, entity graphs, and frame timelines.
- **Harvest adapters (10)**: ChatGPT, Claude, Claude Code, Gemini, Perplexity, PDF, Markdown,
  plain text, URL, and a universal adapter.

For Claude-Code-specific setup (plugin install, lifecycle hooks, `/hive` slash command),
see [`CLAUDE.md`](./CLAUDE.md) and [`docs/INTEGRATIONS.md`](./docs/INTEGRATIONS.md).

# @hive-mind/core

[![npm](https://img.shields.io/npm/v/@hive-mind/core.svg)](https://www.npmjs.com/package/@hive-mind/core)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Local-first memory substrate for AI agents. The engine that powers the hive-mind project.

## What's inside

- **FrameStore** — I/P/B frames (intra / predicted / bidirectional) with automatic compaction
- **HybridSearch** — FTS5 full-text + `sqlite-vec` vector search fused via Reciprocal Rank Fusion
- **KnowledgeGraph** — entities and bitemporal-valid relations
- **IdentityLayer** — persistent user identity
- **AwarenessLayer** — active-task and short-horizon state
- **SessionStore** — group-of-pictures conversation grouping
- **Harvest pipeline** — adapters for ChatGPT, Claude, Claude Code, Gemini, Perplexity, PDF, Markdown, plain text, URL, and universal formats

## Install

```bash
npm install @hive-mind/core
```

Optional peers (only needed for specific harvest adapters and embedding providers):

```bash
npm install @huggingface/transformers pdf-parse
```

## Quick use

```ts
import { MindDB, FrameStore, HybridSearch, KnowledgeGraph } from '@hive-mind/core';

const db = new MindDB('~/.hive-mind/my-project.mind');
const frames = new FrameStore(db);
const search = new HybridSearch(db);

frames.insert({
  frame_type: 'I',
  content: 'User prefers TypeScript over JavaScript',
  importance: 'important',
  source: 'user_stated',
});

const results = await search.query('programming language preferences');
```

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Part of hive-mind

Full docs, architecture diagram, and the MCP server live at the [monorepo root](https://github.com/egzakta/hive-mind).

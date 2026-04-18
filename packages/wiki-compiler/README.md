# @hive-mind/wiki-compiler

[![npm](https://img.shields.io/npm/v/@hive-mind/wiki-compiler.svg)](https://www.npmjs.com/package/@hive-mind/wiki-compiler)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Compile memory frames and knowledge-graph entities from [`@hive-mind/core`](https://www.npmjs.com/package/@hive-mind/core) into interlinked wiki pages using any LLM provider.

## What it produces

- **Entity pages** — one per significant entity (person, project, technology)
- **Concept pages** — synthesized for abstract concepts and recurring themes
- **Synthesis pages** — cross-cutting pages connecting entities and concepts
- **Health reports** — data-quality analysis, gap detection

Compilation is **incremental**: only new or modified frames trigger recompilation.

## Install

```bash
npm install @hive-mind/wiki-compiler @hive-mind/core
```

Bring your own LLM provider — Anthropic SDK is an optional peer:

```bash
npm install @anthropic-ai/sdk
```

## Quick use

```ts
import { MindDB } from '@hive-mind/core';
import { WikiCompiler } from '@hive-mind/wiki-compiler';

const db = new MindDB('~/.hive-mind/my-project.mind');
const compiler = new WikiCompiler(db, { provider: 'anthropic' });

await compiler.compile({ incremental: true });
const report = await compiler.health();
```

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Part of hive-mind

Full docs and architecture at the [monorepo root](https://github.com/marolinik/hive-mind).

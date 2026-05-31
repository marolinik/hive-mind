# @hive-mind/wiki-web

Local, read-only **wiki UI** for [hive-mind](https://github.com/marolinik/hive-mind). Browse the entity, concept, and synthesis pages compiled from your memory frames — entirely on your machine, no network calls.

## Run

```bash
npx @hive-mind/wiki-web         # or: hive-mind-wiki
```

Starts an Express server (default `http://localhost:3717`, override with `PORT`) that renders the pages produced by `@hive-mind/wiki-compiler` from your `~/.hive-mind` data dir. Set `HIVE_MIND_DATA_DIR` to point at a custom location.

## What it shows

- **Entities & concepts** — the knowledge-graph nodes extracted by `cognify`.
- **Synthesis pages** — compiled summaries linking related frames.
- **Search** — debounced keyword filter over the compiled wiki.

It is intentionally read-only: editing happens by adding memories (via the MCP server / hooks), then recompiling the wiki.

## Install

```bash
npm install @hive-mind/wiki-web
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Part of the hive-mind monorepo.

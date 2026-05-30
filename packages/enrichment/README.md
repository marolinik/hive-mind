# @hive-mind/enrichment

In-loop memory **enrichment** for [hive-mind](https://github.com/marolinik/hive-mind) — the layer that turns raw conversation turns into durable, deduplicated, cross-referenced memory while you work.

## What's inside

| Module | Responsibility |
|--------|----------------|
| `synth-queue` | Append-only work queue for asynchronous synthesis (file-locked, crash-safe). |
| `prompt-composer` | Builds the recall block injected at `UserPromptSubmit` (identity + awareness + relevant frames). |
| `query-builder` | Derives the recall query from the current turn. |
| `workspace-deriver` | Maps a working directory to its hive-mind workspace id. |
| `frame-caps` | Caps how many frames a single turn may emit (anti-flood). |
| `post-turn-emit` | Writes I/P/B frames after a turn completes. |
| `contradiction-detector` / `decision-archaeology` / `failure-recall` / `cross-project-recall` | Higher-order recall strategies surfaced during synthesis. |

## Binaries

```bash
hive-mind-synth-queue   # enqueue a synthesis task
hive-mind-synth-drain   # drain pending synthesis tasks (nightly cron / Stop hook)
```

## Install

```bash
npm install @hive-mind/enrichment
```

Consumed by `@hive-mind/claude-code-hooks` and `@hive-mind/wiki-web`. Talks to the memory core over the CLI bridge (`@hive-mind/cli`), so it stays decoupled from the native better-sqlite3 binding.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Part of the hive-mind monorepo.

# @hive-mind/cli

[![npm](https://img.shields.io/npm/v/@hive-mind/cli.svg)](https://www.npmjs.com/package/@hive-mind/cli)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Command-line tools for hive-mind memory. Designed to run from `SessionStart` / `Stop` hooks and nightly cron jobs — wherever you need a shell-driven way to read from, write to, or maintain a hive-mind workspace.

## Install

```bash
npm install -g @hive-mind/cli
```

or run without installing:

```bash
npx @hive-mind/cli recall-context "what do I know about X"
```

## Commands

| Command | Purpose |
|---|---|
| `recall-context <query>` | Hybrid FTS5 + vector search over memory frames |
| `save-session` | Persist current session transcript as memory frames |
| `harvest-local` | Ingest ChatGPT / Claude / Gemini / PDF / Markdown / URL exports |
| `cognify` | Extract entities and relations into the knowledge graph |
| `compile-wiki` | Compile memory into interlinked wiki pages |
| `maintenance` | Compact superseded frames, clean up deprecated data |

Every command supports `--json` for machine-readable output and `--help` for flags.

## Examples

```bash
# Recall
hive-mind-cli recall-context "deployment pipeline decisions"

# Save a Claude Code session transcript
hive-mind-cli save-session --file ./claude-session.md

# Harvest a folder of ChatGPT exports
hive-mind-cli harvest-local --source chatgpt --path ./exports

# Nightly maintenance
hive-mind-cli maintenance --compact --cleanup
```

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Part of hive-mind

Full docs at the [monorepo root](https://github.com/marolinik/hive-mind).

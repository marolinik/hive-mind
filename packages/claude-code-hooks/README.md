# @hive-mind/claude-code-hooks

[Claude Code](https://docs.claude.com/en/docs/claude-code) hooks for [hive-mind](https://github.com/marolinik/hive-mind) — in-loop memory recall + asynchronous synthesis, wired into the agent's lifecycle.

## The five hooks

| Hook | When | What it does |
|------|------|--------------|
| `SessionStart` | session opens | Injects identity + awareness + a catch-up drain of pending synthesis. |
| `UserPromptSubmit` | each prompt | Recalls relevant frames and prepends them as context. |
| `PostToolUse` | after a tool runs | Captures salient tool outcomes as candidate frames. |
| `Stop` | turn ends | Emits I/P/B frames and enqueues synthesis. |
| `PreCompact` | before compaction | Flushes durable memory so nothing is lost to the compactor. |

## Install

```bash
npx @hive-mind/claude-code-hooks install     # or: hive-mind-hooks
```

The installer merges hive-mind's hook entries into your Claude Code `settings.json` with a **byte-identical, reversible backup**. Remove them with `hive-mind-hooks uninstall`; check state with `hive-mind-hooks verify`.

Recall/save run through `@hive-mind/cli` (subprocess bridge), and enrichment is provided by `@hive-mind/enrichment`. The memory backend is the same `@hive-mind/core` used by every other hive-mind adapter and by the MCP server — so memory is shared across tools.

## MCP-only alternative

If you only want the tools (no lifecycle hooks), register the MCP server instead — see the repo's [`docs/INTEGRATIONS.md`](../../docs/INTEGRATIONS.md) and [`AGENTS.md`](../../AGENTS.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Part of the hive-mind monorepo.

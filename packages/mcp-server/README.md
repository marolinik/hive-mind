# @hive-mind/mcp-server

[![npm](https://img.shields.io/npm/v/@hive-mind/mcp-server.svg)](https://www.npmjs.com/package/@hive-mind/mcp-server)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-green.svg)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

MCP server exposing **21 tools + 4 resources** backed by [`@hive-mind/core`](https://www.npmjs.com/package/@hive-mind/core) over stdio.

Plug it into Claude Code, Claude Desktop, Codex, Hermes, or any MCP-compatible client.

## Install and run

### Claude Code / Claude Desktop / Codex

Add to `~/.claude/settings.json` (or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hive-mind": {
      "command": "npx",
      "args": ["-y", "@hive-mind/mcp-server"]
    }
  }
}
```

### Any MCP client over stdio

```bash
npx -y @hive-mind/mcp-server
```

## Tools (21)

| Category | Tools |
|---|---|
| Memory | `recall_memory`, `save_memory` |
| Knowledge graph | `search_entities`, `add_relation`, `get_entity` |
| Identity | `get_identity`, `set_identity` |
| Awareness | `get_awareness`, `set_awareness`, `clear_awareness` |
| Workspace | `list_workspaces`, `switch_workspace` |
| Harvest | `harvest_conversations`, `harvest_status`, `ingest_source` |
| Cleanup | `compact_memory`, `cleanup_deprecated` |
| Wiki | `compile_wiki`, `search_wiki`, `get_page`, `compile_health` |

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Part of hive-mind

Full docs and architecture at the [monorepo root](https://github.com/marolinik/hive-mind).

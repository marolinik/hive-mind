# Integrations

How to connect hive-mind's MCP server to each client. Every integration runs the
identical command — `npx @hive-mind/mcp-server` — over stdio transport. The server
exposes 21 MCP tools (memory, knowledge graph, identity, awareness, workspaces,
harvest, ingest, cleanup, wiki).

When namespaced inside Claude Code, the tools appear as `mcp__hive-mind__<tool>`
(e.g. `mcp__hive-mind__recall_memory`).

---

## Claude Code (plugin) — recommended

Installs the MCP server **plus** 5 lifecycle hooks (SessionStart, UserPromptSubmit,
Stop, PreCompact, PostToolUse) for in-loop memory **plus** the `/hive <query>` slash
command. Cross-platform — no PowerShell vs bash split.

```
/plugin marketplace add marolinik/hive-mind
/plugin install hive-mind@hive-mind
```

What you get:
- 5 hooks active (in-loop memory + synth queue draining + decision archaeology + contradiction detection)
- `@hive-mind/mcp-server` auto-registered (21 tools)
- `/hive <query>` slash command for ad-hoc wiki search + recent-frame recall

---

## Claude Code (MCP-only)

If you only want the MCP server (no in-loop hooks), add to your
`~/.claude/settings.json`:

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

---

## Claude Desktop

Add to `claude_desktop_config.json`. The file lives in an OS-specific location:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%/Claude/claude_desktop_config.json`

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

Restart Claude Desktop after editing the config.

---

## Codex

Add the same `mcpServers` block to your Codex MCP configuration:

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

---

## Cursor

Cursor reads MCP servers from a JSON config. Add hive-mind either via
**Settings → MCP** (UI) or by editing Cursor's MCP config file directly (commonly
the project-level `.cursor/mcp.json`, or the global Cursor MCP config — see Cursor's
own docs for the exact path on your platform). The block is the same:

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

---

## Hermes

Hermes launches the server over stdio:

```bash
npx @hive-mind/mcp-server
```

---

## OpenClaw

OpenClaw uses a generic MCP stdio client config. Add hive-mind to the client's MCP
servers map (consult OpenClaw's docs for the exact config-file location on your
platform). The command and args are the same as every other client:

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

---

## Any MCP client (generic stdio)

Any MCP-compatible client can launch hive-mind directly over stdio:

- **command:** `npx`
- **args:** `["@hive-mind/mcp-server"]`
- **transport:** stdio

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

Or invoke it directly:

```bash
npx @hive-mind/mcp-server
```

---

## Shared configuration

These environment variables apply to **every** integration. Pass them via the
client's `env` map inside the server block — they configure where data lives and how
embeddings are generated.

- `HIVE_MIND_DATA_DIR` — directory for the SQLite `.mind` databases (default: `~/.hive-mind`).
- `HIVE_MIND_EMBEDDING_PROVIDER` — selects the embedding backend.
- Embedding-provider API keys (set the one matching your provider): `OPENAI_API_KEY`,
  `VOYAGE_API_KEY`, or for local models `OLLAMA_URL` / `OLLAMA_MODEL`.
  (`ANTHROPIC_API_KEY` is used for wiki synthesis / LLM extraction, not embeddings.)

Example with env vars in a JSON config:

```json
{
  "mcpServers": {
    "hive-mind": {
      "command": "npx",
      "args": ["@hive-mind/mcp-server"],
      "env": {
        "HIVE_MIND_DATA_DIR": "~/.hive-mind",
        "HIVE_MIND_EMBEDDING_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

---

## Verification

On startup the server logs `Hive Mind Memory MCP server running on stdio` to stderr.

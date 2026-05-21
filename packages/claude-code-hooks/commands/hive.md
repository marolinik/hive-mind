---
name: hive
description: Ad-hoc query against the local hive-mind. Returns top matching wiki pages and recent frames from the current workspace + personal mind, inline. Use to quickly check "what do we already know about X?".
---

# /hive — Ad-hoc hive-mind query

You are answering the user's question using their local hive-mind memory. The hive-mind MCP server is already running (auto-registered by this plugin) — call the MCP tools directly.

## Steps

1. **Take the query from `$ARGUMENTS`** — that's the user's search term.
2. **Search wiki pages** (workspace-scoped first, then personal):
   - Call `mcp__hive-mind__search_wiki` with `{ query: $ARGUMENTS, limit: 5 }`
   - If the active workspace has pages, prefer those
3. **Recall recent frames** (workspace-scoped + cross-workspace):
   - Call `mcp__hive-mind__recall_memory` with `{ query: $ARGUMENTS, limit: 8, scope: "all", profile: "balanced" }`
4. **Compose a tight answer**:
   - One short paragraph synthesizing what the memory says about the topic
   - Bullet list of top 3 wiki hits (page name + 1-line excerpt) if any
   - Bullet list of top 3-5 recent frames (date + 1-line excerpt) if any
   - Cite frame IDs and wiki slugs so the user can drill in

## Output format

```
## hive-mind says about "$ARGUMENTS"

<one-paragraph synthesis>

**Wiki pages:**
- [slug] one-line excerpt (workspace: <ws_id or "personal">)
- ...

**Recent frames:**
- <date>: one-line excerpt (id: <frame_id>, ws: <ws>)
- ...
```

If both wiki and recall return empty, say so plainly: `No matches in hive-mind for "$ARGUMENTS". Try a broader term, or save a memory first.`

Do not call external tools, search the web, or open the codebase. This command is strictly a memory query.

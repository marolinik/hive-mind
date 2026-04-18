#!/usr/bin/env node

/**
 * Hive Mind Memory MCP Server
 *
 * Persistent memory for Claude Code, Claude Desktop, Codex, Hermes, and any
 * MCP-compatible AI system. Powered by @hive-mind/core — FrameStore +
 * HybridSearch + KnowledgeGraph + IdentityLayer + AwarenessLayer.
 *
 * Transport: stdio (Claude Code / Claude Desktop / Codex standard)
 * Data dir:  HIVE_MIND_DATA_DIR (default: ~/.hive-mind)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { initialize, shutdown } from './core/setup.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerIdentityTools } from './tools/identity.js';
import { registerAwarenessTools } from './tools/awareness.js';
import { registerWorkspaceTools } from './tools/workspace.js';
import { registerHarvestTools } from './tools/harvest.js';
import { registerCleanupTools } from './tools/cleanup.js';
import { registerIngestTools } from './tools/ingest.js';
import { registerWikiTools } from './tools/wiki.js';
import { registerResources } from './resources/memory.js';

// ── Server creation ─────────────────────────────────────────────────

const server = new McpServer(
  {
    name: 'hive-mind-memory',
    version: '0.1.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      logging: {},
    },
    instructions: [
      'Hive Mind gives you persistent memory across conversations.',
      '',
      'Core workflow:',
      '1. Use recall_memory FIRST to check if relevant context exists',
      '2. Use save_memory to persist important facts, decisions, and preferences',
      '3. Use search_entities to explore the knowledge graph',
      '4. Use get_identity / get_awareness for user context',
      '',
      'Wiki compiler:',
      '5. Use compile_wiki to build a personal wiki from your memories',
      '6. Use search_wiki / get_page to browse compiled knowledge',
      '7. Use compile_health to check data quality and find gaps',
      '8. Use ingest_source to add documents, URLs, or files to memory',
      '',
      'Memory is stored locally and persists across sessions.',
      'Workspaces provide isolated memory spaces for different projects.',
    ].join('\n'),
  },
);

// ── Register all tools ──────────────────────────────────────────────

registerMemoryTools(server);
registerKnowledgeTools(server);
registerIdentityTools(server);
registerAwarenessTools(server);
registerWorkspaceTools(server);
registerHarvestTools(server);
registerCleanupTools(server);
registerIngestTools(server);
registerWikiTools(server);

// ── Register all resources ──────────────────────────────────────────

registerResources(server);

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Initialize the memory engine (MindDB, embeddings, workspace manager)
  await initialize();

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error('Hive Mind Memory MCP server running on stdio');
  console.error(`Data directory: ${process.env.HIVE_MIND_DATA_DIR ?? '~/.hive-mind'}`);
}

// ── Graceful shutdown ───────────────────────────────────────────────

function handleShutdown(): void {
  console.error('Shutting down Hive Mind Memory MCP server...');
  shutdown();
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// ── Launch ──────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Fatal error starting Hive Mind Memory MCP server:', err);
  shutdown();
  process.exit(1);
});

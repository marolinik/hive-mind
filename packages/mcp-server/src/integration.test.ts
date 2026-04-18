import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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

/**
 * A hand-rolled stub that satisfies the subset of the McpServer API
 * the register functions call:
 *
 *   server.tool(name, description, schema, handler)
 *   server.resource(name, uri, handler)
 *
 * The stub captures `name` / `description` / `uri` so tests can assert
 * which tools got wired up, without spinning up a real MCP server or
 * the stdio transport.
 */
function makeStub(): {
  server: McpServer;
  tools: { name: string; description: string }[];
  resources: { name: string; uri: string }[];
} {
  const tools: { name: string; description: string }[] = [];
  const resources: { name: string; uri: string }[] = [];
  const server = {
    tool: (name: string, description: string, _schema: unknown, _handler: unknown) => {
      tools.push({ name, description });
    },
    resource: (name: string, uri: string, _handler: unknown) => {
      resources.push({ name, uri });
    },
  } as unknown as McpServer;
  return { server, tools, resources };
}

describe('@hive-mind/mcp-server registration wiring', () => {
  it('registerMemoryTools registers save_memory + recall_memory', () => {
    const { server, tools } = makeStub();
    registerMemoryTools(server);
    expect(tools.map((t) => t.name).sort()).toEqual(['recall_memory', 'save_memory']);
    // Every tool description should be non-trivial (> 30 chars) so the MCP
    // client actually sees useful guidance.
    for (const t of tools) expect(t.description.length).toBeGreaterThan(30);
  });

  it('registerKnowledgeTools registers search_entities + save_entity + create_relation', () => {
    const { server, tools } = makeStub();
    registerKnowledgeTools(server);
    expect(tools.map((t) => t.name).sort()).toEqual(['create_relation', 'save_entity', 'search_entities']);
  });

  it('registerIdentityTools registers get_identity + set_identity', () => {
    const { server, tools } = makeStub();
    registerIdentityTools(server);
    expect(tools.map((t) => t.name).sort()).toEqual(['get_identity', 'set_identity']);
  });

  it('registerAwarenessTools registers get/set/clear_awareness', () => {
    const { server, tools } = makeStub();
    registerAwarenessTools(server);
    expect(tools.map((t) => t.name).sort()).toEqual(['clear_awareness', 'get_awareness', 'set_awareness']);
  });

  it('registerWorkspaceTools registers list_workspaces + create_workspace', () => {
    const { server, tools } = makeStub();
    registerWorkspaceTools(server);
    expect(tools.map((t) => t.name).sort()).toEqual(['create_workspace', 'list_workspaces']);
  });

  it('registerHarvestTools registers harvest_import + harvest_sources', () => {
    const { server, tools } = makeStub();
    registerHarvestTools(server);
    expect(tools.map((t) => t.name).sort()).toEqual(['harvest_import', 'harvest_sources']);
  });

  it('registerCleanupTools registers cleanup_frames + cleanup_entities', () => {
    const { server, tools } = makeStub();
    registerCleanupTools(server);
    expect(tools.map((t) => t.name).sort()).toEqual(['cleanup_entities', 'cleanup_frames']);
  });

  it('registerIngestTools registers ingest_source', () => {
    const { server, tools } = makeStub();
    registerIngestTools(server);
    expect(tools.map((t) => t.name)).toEqual(['ingest_source']);
  });

  it('registerWikiTools registers compile_wiki + get_page + search_wiki + compile_health', () => {
    const { server, tools } = makeStub();
    registerWikiTools(server);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compile_health', 'compile_wiki', 'get_page', 'search_wiki',
    ]);
  });

  it('registerResources registers the 4 memory:// resource roots', () => {
    const { server, resources } = makeStub();
    registerResources(server);
    const names = resources.map((r) => r.name).sort();
    expect(names).toEqual(['awareness', 'identity', 'personal-stats', 'workspace']);
    // All URIs should be under the memory:// scheme so the client namespaces them together.
    for (const r of resources) expect(r.uri.startsWith('memory://')).toBe(true);
  });

  it('full registration surface adds up to 21 tools + 4 resources', () => {
    const { server, tools, resources } = makeStub();
    registerMemoryTools(server);
    registerKnowledgeTools(server);
    registerIdentityTools(server);
    registerAwarenessTools(server);
    registerWorkspaceTools(server);
    registerHarvestTools(server);
    registerCleanupTools(server);
    registerIngestTools(server);
    registerWikiTools(server);
    registerResources(server);

    expect(tools).toHaveLength(21);
    expect(resources).toHaveLength(4);

    // Every tool name is unique — duplicates would cause MCP registration errors at runtime.
    const names = new Set(tools.map((t) => t.name));
    expect(names.size).toBe(tools.length);
  });
});

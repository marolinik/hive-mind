import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as setup from './core/setup.js';
import { registerMemoryTools } from './tools/memory.js';

/**
 * MCP/CLI parity regression: recall_memory must apply the cross-encoder
 * reranker the same way the CLI's recall-context does. The CLI path
 * (packages/cli/src/commands/recall-context.ts) lazy-loads a reranker via
 * env.getReranker() and threads it into search.search(); the MCP path
 * historically built searchOpts WITHOUT a reranker, silently degrading
 * MCP-client retrieval. This test pins the wiring.
 *
 * It is hermetic: temp data dir + mock embedding provider, no network, no
 * ~87MB ONNX model. The reranker is a fake whose scoreBatch we observe —
 * HybridSearch only calls reranker.scoreBatch when options.reranker is set,
 * so an observed call proves recall_memory threaded the reranker through.
 */

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function captureServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
    resource: () => { /* unused here */ },
  } as unknown as Parameters<typeof registerMemoryTools>[0];
  return { server, handlers };
}

describe('recall_memory applies the reranker (MCP/CLI parity)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-rerank-'));
    process.env.HIVE_MIND_DATA_DIR = dir;
    process.env.HIVE_MIND_EMBEDDING_PROVIDER = 'mock';
    // Real loader would return undefined here anyway; we override via spy so the
    // test never touches the heavy model.
    process.env.HIVE_MIND_NO_RERANK = '1';
    await setup.initialize();
  });

  afterEach(() => {
    setup.shutdown();
    delete process.env.HIVE_MIND_DATA_DIR;
    delete process.env.HIVE_MIND_EMBEDDING_PROVIDER;
    delete process.env.HIVE_MIND_NO_RERANK;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('threads the reranker from setup.getReranker() into the personal search', async () => {
    // Seed a couple of keyword-matching frames so the RRF survivor pool is non-empty.
    const frames = setup.getFrameStore();
    const sessions = setup.getSessions();
    const search = setup.getSearch();
    const s = sessions.ensure('test', undefined, 'test session');
    const f1 = frames.createIFrame(s.gop_id, 'alpha apple pie', 'normal', 'system');
    const f2 = frames.createIFrame(s.gop_id, 'alpha banana split', 'normal', 'system');
    await search.indexFrame(f1.id, 'alpha apple pie');
    await search.indexFrame(f2.id, 'alpha banana split');

    // Fake reranker: identity-scored, but records that it was invoked.
    const scoreBatch = vi.fn(async (_query: string, docs: string[]) => docs.map((_d, i) => docs.length - i));
    vi.spyOn(setup, 'getReranker').mockResolvedValue({ scoreBatch } as never);

    const { server, handlers } = captureServer();
    registerMemoryTools(server);
    const recall = handlers.get('recall_memory');
    expect(recall).toBeDefined();

    await recall!({ query: 'alpha', scope: 'personal' });

    // recall_memory must have asked setup for a reranker AND passed it to search
    // (HybridSearch only calls scoreBatch when options.reranker is present).
    expect(setup.getReranker).toHaveBeenCalled();
    expect(scoreBatch).toHaveBeenCalled();
    expect(scoreBatch.mock.calls[0][0]).toBe('alpha');
  });
});

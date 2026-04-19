import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { openPersonalMind, type CliEnv } from './setup.js';
import { dispatch } from './dispatch.js';
import { runMcpCall } from './commands/mcp-call.js';

describe('cli dispatch', () => {
  let dataDir: string;
  let env: CliEnv;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hmind-cli-dispatch-'));
    env = openPersonalMind(dataDir);
    // Seed a session + a few frames the commands can recall/cognify over.
    env.db.getDatabase().prepare(
      "INSERT INTO sessions (gop_id, status, started_at) VALUES ('g-cli', 'active', datetime('now'))",
    ).run();
    env.frames.createIFrame('g-cli', 'Alice works at Acme Corp on Project Alpha', 'important', 'user_stated');
    env.frames.createIFrame('g-cli', 'Bob prefers TypeScript over JavaScript for backend work', 'normal', 'user_stated');
    env.frames.createIFrame('g-cli', 'The weekly review happens every Thursday at 2pm', 'normal', 'user_stated');
  });

  afterEach(() => {
    env.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('recall-context returns hits as plain text when no --json flag', async () => {
    const out = await dispatch({
      subcommand: 'recall-context',
      values: { limit: '5' },
      positionals: ['Alice Acme'],
      env,
    });
    expect(out).toBeDefined();
    expect(out).toContain('Recalled context');
    expect(out).toContain('Alice');
  });

  it('recall-context with --json emits JSON envelope', async () => {
    const out = await dispatch({
      subcommand: 'recall-context',
      values: { json: true, limit: '5' },
      positionals: ['Alice'],
      env,
    });
    const parsed = JSON.parse(out!) as { query: string; hits: Array<{ content: string }> };
    expect(parsed.query).toBe('Alice');
    expect(Array.isArray(parsed.hits)).toBe(true);
  });

  it('recall-context rejects missing query', async () => {
    await expect(dispatch({
      subcommand: 'recall-context',
      values: {},
      positionals: [],
      env,
    })).rejects.toThrow(/requires a query/);
  });

  it('save-session from --file persists an I-Frame', async () => {
    const filePath = join(dataDir, 'session.txt');
    writeFileSync(filePath, 'Today we decided to ship the new auth module behind a feature flag.');

    const out = await dispatch({
      subcommand: 'save-session',
      values: { json: true, file: filePath },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as { saved: boolean; frameId?: number };
    expect(parsed.saved).toBe(true);
    expect(typeof parsed.frameId).toBe('number');
  });

  it('save-session rejects too-short input', async () => {
    const filePath = join(dataDir, 'short.txt');
    writeFileSync(filePath, 'hi');

    const out = await dispatch({
      subcommand: 'save-session',
      values: { json: true, file: filePath },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as { saved: boolean; reason?: string };
    expect(parsed.saved).toBe(false);
    expect(parsed.reason).toMatch(/too short/i);
  });

  it('harvest-local rejects missing --source or --path', async () => {
    await expect(dispatch({
      subcommand: 'harvest-local',
      values: { source: 'chatgpt' },
      positionals: [],
      env,
    })).rejects.toThrow(/--path/);

    await expect(dispatch({
      subcommand: 'harvest-local',
      values: { path: '/tmp/x.json' },
      positionals: [],
      env,
    })).rejects.toThrow(/--source/);
  });

  it('harvest-local reports missing file as an error (non-throwing)', async () => {
    const out = await dispatch({
      subcommand: 'harvest-local',
      values: {
        json: true,
        source: 'chatgpt',
        path: join(dataDir, 'does-not-exist.json'),
      },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as { errors: string[] };
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]).toMatch(/not found/i);
  });

  it('harvest-local parses a minimal ChatGPT export into frames', async () => {
    const exportPath = join(dataDir, 'chatgpt.json');
    writeFileSync(exportPath, JSON.stringify([
      {
        id: 'conv-1',
        title: 'Greeting',
        create_time: 1_700_000_000,
        mapping: {
          m1: {
            id: 'm1',
            message: {
              author: { role: 'user' },
              create_time: 1_700_000_001,
              content: { parts: ['Hello from chatgpt export'] },
            },
          },
        },
      },
    ]));

    const out = await dispatch({
      subcommand: 'harvest-local',
      values: { json: true, source: 'chatgpt', path: exportPath },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as { itemsFound: number; framesCreated: number };
    expect(parsed.itemsFound).toBeGreaterThan(0);
    expect(parsed.framesCreated).toBeGreaterThan(0);
  });

  it('cognify scans the seeded frames and reports a run', async () => {
    const out = await dispatch({
      subcommand: 'cognify',
      values: { json: true },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as { framesScanned: number; entitiesCreated: number };
    expect(parsed.framesScanned).toBeGreaterThanOrEqual(3);
    // The seed data includes capitalised multi-word candidates (Acme Corp, Project Alpha).
    expect(parsed.entitiesCreated + 0).toBeGreaterThan(0);
  });

  it('compile-wiki runs against the real core + wiki-compiler (echo synthesizer)', async () => {
    // No ANTHROPIC_API_KEY / OLLAMA_URL in the test env → echo fallback.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OLLAMA_URL;

    const out = await dispatch({
      subcommand: 'compile-wiki',
      values: { json: true, mode: 'full' },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as { provider: string; pagesCreated: number; mode: string };
    expect(parsed.mode).toBe('full');
    // With no entities in the KG, there should still be an index page at least.
    expect(parsed.provider).toBe('echo');
  });

  it('maintenance runs the requested ops in sequence', async () => {
    const out = await dispatch({
      subcommand: 'maintenance',
      values: {
        json: true,
        compact: true,
        'wipe-imports': true,
        cognify: true,
      },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as {
      compact?: unknown;
      wipeImports?: unknown;
      cognify?: unknown;
      durationMs: number;
    };
    expect(parsed.compact).toBeDefined();
    expect(parsed.wipeImports).toBeDefined();
    expect(parsed.cognify).toBeDefined();
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects unknown subcommand', async () => {
    await expect(dispatch({
      subcommand: 'teleport',
      values: {},
      positionals: [],
      env,
    })).rejects.toThrow(/Unknown subcommand/);
  });

  it('init on a populated env reports the existing mind', async () => {
    const out = await dispatch({
      subcommand: 'init',
      values: { json: true },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as {
      dataDir: string;
      personalMindPath: string;
      personalMindCreated: boolean;
      dataDirCreated: boolean;
    };
    expect(parsed.dataDir).toBe(dataDir);
    expect(parsed.personalMindPath).toContain('personal.mind');
    // Already opened by the beforeEach hook → should be reported as existing.
    expect(parsed.personalMindCreated).toBe(false);
    expect(parsed.dataDirCreated).toBe(false);
  });

  it('init plain-text output lists next-step commands', async () => {
    const out = await dispatch({
      subcommand: 'init',
      values: {},
      positionals: [],
      env,
    });
    expect(out).toContain('Personal mind exists');
    expect(out).toContain('hive-mind-cli status');
    expect(out).toContain('hive-mind-cli recall-context');
  });

  it('status --json reports seeded frame count and entities', async () => {
    // Cognify first so the entity-count column is non-zero.
    await dispatch({
      subcommand: 'cognify',
      values: { json: true },
      positionals: [],
      env,
    });

    const out = await dispatch({
      subcommand: 'status',
      values: { json: true },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as {
      dataDir: string;
      personalMindExists: boolean;
      frames: number;
      entities: number;
      relations: number;
      lastFrame: { id: number; source: string; preview: string } | null;
    };
    expect(parsed.personalMindExists).toBe(true);
    expect(parsed.frames).toBeGreaterThanOrEqual(3);
    expect(parsed.entities).toBeGreaterThan(0);
    expect(parsed.lastFrame).not.toBeNull();
    expect(parsed.lastFrame?.source).toBe('user_stated');
    expect(parsed.lastFrame?.preview.length).toBeGreaterThan(0);
  });

  it('status plain-text renders a human-readable summary', async () => {
    const out = await dispatch({
      subcommand: 'status',
      values: {},
      positionals: [],
      env,
    });
    expect(out).toContain('hive-mind status');
    expect(out).toContain('frames:');
    expect(out).toContain('entities:');
    expect(out).toContain('relations:');
    expect(out).toContain('last frame:');
  });

  it('status truncates long frame content in preview', async () => {
    // Seed a long frame so preview truncation is exercised.
    const longContent = 'This is a deliberately long frame body. '.repeat(10);
    env.frames.createIFrame('g-cli', longContent, 'normal', 'user_stated');

    const out = await dispatch({
      subcommand: 'status',
      values: { json: true },
      positionals: [],
      env,
    });
    const parsed = JSON.parse(out!) as { lastFrame: { preview: string } };
    expect(parsed.lastFrame.preview.length).toBeLessThanOrEqual(80);
    expect(parsed.lastFrame.preview.endsWith('…')).toBe(true);
  });

  it('mcp-call rejects missing tool name', async () => {
    await expect(dispatch({
      subcommand: 'mcp-call',
      values: {},
      positionals: [],
    })).rejects.toThrow(/tool name/);
  });

  it('mcp-call rejects invalid --args JSON', async () => {
    await expect(dispatch({
      subcommand: 'mcp-call',
      values: { args: '{not json' },
      positionals: ['recall_memory'],
    })).rejects.toThrow(/not valid JSON/);
  });
});

/**
 * MCP-call tests using the `transport` override so we never spawn a real
 * child process. These verify the JSON-RPC handshake + response matching
 * logic, not the server itself (the smoke script covers the real server).
 */
describe('runMcpCall (transport mock)', () => {
  function makeMockTransport(responses: Array<Record<string, unknown>>) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let killed = false;

    // Watch stdin for requests and emit canned responses for each id.
    let buffer = '';
    stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          try {
            const req = JSON.parse(line) as { id?: number; method?: string };
            if (typeof req.id === 'number') {
              const match = responses.find((r) => r['id'] === req.id);
              if (match) {
                stdout.write(JSON.stringify(match) + '\n');
              }
            }
          } catch { /* ignore parse errors */ }
        }
        idx = buffer.indexOf('\n');
      }
    });

    return () => ({
      stdin,
      stdout,
      kill: () => { killed = true; stdin.end(); stdout.end(); },
      exitPromise: Promise.resolve(killed ? 0 : 0),
    });
  }

  it('runs initialize + tools/call and returns the content array', async () => {
    const transport = makeMockTransport([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'mock', version: '0.0.1' },
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [{ type: 'text', text: 'hello from the mock tool' }],
          isError: false,
        },
      },
    ]);

    const result = await runMcpCall({
      tool: 'recall_memory',
      args: { query: 'hello' },
      transport,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.tool).toBe('recall_memory');
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content![0].text).toContain('hello from the mock tool');
  });

  it('surfaces MCP error responses', async () => {
    const transport = makeMockTransport([
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {} } },
      { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Unknown tool: teleport' } },
    ]);

    const result = await runMcpCall({
      tool: 'teleport',
      transport,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown tool: teleport');
  });

  it('times out when the server never responds', async () => {
    // Transport that emits no responses.
    const transport = makeMockTransport([]);

    const result = await runMcpCall({
      tool: 'recall_memory',
      transport,
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });

  it('rejects missing tool at the entry point', async () => {
    const result = await runMcpCall({ tool: '', timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tool name is required/);
  });
});

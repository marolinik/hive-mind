import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersonalMind, type CliEnv } from './setup.js';
import { dispatch } from './dispatch.js';

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
});

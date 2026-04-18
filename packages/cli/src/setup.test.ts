import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersonalMind, resolveDataDir } from './setup.js';

describe('cli setup', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hmind-cli-setup-'));
  });

  afterEach(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    delete process.env.HIVE_MIND_DATA_DIR;
  });

  it('resolveDataDir() returns ~/.hive-mind when env is unset', () => {
    const resolved = resolveDataDir();
    expect(resolved.endsWith('.hive-mind')).toBe(true);
  });

  it('resolveDataDir() honours HIVE_MIND_DATA_DIR', () => {
    process.env.HIVE_MIND_DATA_DIR = dataDir;
    expect(resolveDataDir()).toBe(dataDir);
  });

  it('resolveDataDir() expands a leading tilde against $HOME', () => {
    process.env.HIVE_MIND_DATA_DIR = '~/some-path';
    const resolved = resolveDataDir();
    expect(resolved.endsWith('some-path')).toBe(true);
    expect(resolved.startsWith('/') || /^[A-Z]:/.test(resolved)).toBe(true);
  });

  it('openPersonalMind() creates personal.mind and every layer', () => {
    const env = openPersonalMind(dataDir);
    expect(existsSync(join(dataDir, 'personal.mind'))).toBe(true);
    expect(env.frames).toBeDefined();
    expect(env.kg).toBeDefined();
    expect(env.identity).toBeDefined();
    expect(env.awareness).toBeDefined();
    expect(env.sessions).toBeDefined();
    expect(env.harvestSources).toBeDefined();
    expect(env.workspaces).toBeDefined();
    expect(env.mindCache).toBeDefined();
    env.close();
  });

  it('getEmbedder() caches the provider across calls', async () => {
    const env = openPersonalMind(dataDir);
    try {
      const a = await env.getEmbedder();
      const b = await env.getEmbedder();
      expect(a).toBe(b);
    } finally {
      env.close();
    }
  });

  it('getSearch() wires HybridSearch with the shared MindDB', async () => {
    const env = openPersonalMind(dataDir);
    try {
      const search = await env.getSearch();
      expect(search).toBeDefined();
      // Same instance on second call.
      expect(await env.getSearch()).toBe(search);
    } finally {
      env.close();
    }
  });
});

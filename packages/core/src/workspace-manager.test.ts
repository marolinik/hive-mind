import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from './workspace-manager.js';

describe('WorkspaceManager', () => {
  let baseDir: string;
  let wm: WorkspaceManager;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'hmind-wm-'));
    wm = new WorkspaceManager(baseDir);
  });

  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('create() lays out the workspace dir with config, mind file, and sessions/', () => {
    const ws = wm.create({ name: 'Alpha', group: 'Personal' });
    expect(ws.id).toBe('alpha');
    expect(ws.group).toBe('Personal');
    expect(ws.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const wsDir = join(baseDir, 'workspaces', ws.id);
    expect(existsSync(join(wsDir, 'workspace.json'))).toBe(true);
    expect(existsSync(join(wsDir, 'workspace.mind'))).toBe(true);
    expect(existsSync(join(wsDir, 'sessions'))).toBe(true);
  });

  it('create() only persists provided optional fields (no undefined values)', () => {
    const ws = wm.create({ name: 'Lean', group: 'Personal' });
    expect(Object.keys(ws)).toEqual(['id', 'name', 'group', 'created']);
  });

  it('generateId() appends a counter when the slug already exists', () => {
    const a = wm.create({ name: 'Project X', group: 'Work' });
    const b = wm.create({ name: 'Project X', group: 'Work' });
    const c = wm.create({ name: 'Project X', group: 'Work' });
    expect(a.id).toBe('project-x');
    expect(b.id).toBe('project-x-2');
    expect(c.id).toBe('project-x-3');
  });

  it('list() / listByGroup() / listGroups() round-trip', () => {
    wm.create({ name: 'Alpha', group: 'Personal' });
    wm.create({ name: 'Beta', group: 'Work' });
    wm.create({ name: 'Gamma', group: 'Work' });

    expect(wm.list()).toHaveLength(3);
    expect(wm.listByGroup('Work').map((w) => w.name).sort()).toEqual(['Beta', 'Gamma']);
    expect(wm.listGroups().sort()).toEqual(['Personal', 'Work']);
  });

  it('get() returns null for unknown id and config for known id', () => {
    expect(wm.get('nope')).toBeNull();
    const ws = wm.create({ name: 'Alpha', group: 'Personal', model: 'claude-sonnet' });
    const loaded = wm.get(ws.id);
    expect(loaded?.name).toBe('Alpha');
    expect(loaded?.model).toBe('claude-sonnet');
  });

  it('update() writes partial changes while preserving id + created', () => {
    const ws = wm.create({ name: 'Alpha', group: 'Personal' });
    wm.update(ws.id, { name: 'Alpha Renamed', icon: '🎯' });
    const loaded = wm.get(ws.id)!;
    expect(loaded.id).toBe(ws.id);
    expect(loaded.created).toBe(ws.created);
    expect(loaded.name).toBe('Alpha Renamed');
    expect(loaded.icon).toBe('🎯');
  });

  it('update() throws when the workspace does not exist', () => {
    expect(() => wm.update('nope', { name: 'x' })).toThrow(/not found/i);
  });

  it('delete() removes the workspace directory entirely', () => {
    const ws = wm.create({ name: 'Alpha', group: 'Personal' });
    wm.delete(ws.id);
    expect(wm.get(ws.id)).toBeNull();
    expect(existsSync(join(baseDir, 'workspaces', ws.id))).toBe(false);
  });

  it('getMindPath() returns the canonical per-workspace .mind path', () => {
    const ws = wm.create({ name: 'Alpha', group: 'Personal' });
    const expected = join(baseDir, 'workspaces', ws.id, 'workspace.mind');
    expect(wm.getMindPath(ws.id)).toBe(expected);
  });

  it('setDefault()/getDefault() persist across fresh manager instances', () => {
    const ws = wm.create({ name: 'Alpha', group: 'Personal' });
    wm.setDefault(ws.id);
    expect(wm.getDefault()).toBe(ws.id);

    const wmReopen = new WorkspaceManager(baseDir);
    expect(wmReopen.getDefault()).toBe(ws.id);
  });

  it('setDefault() throws on unknown id', () => {
    expect(() => wm.setDefault('nope')).toThrow(/not found/i);
  });

  it('ensureDefault() creates + sets default when no workspace exists yet', () => {
    expect(wm.list()).toHaveLength(0);
    const ws = wm.ensureDefault();
    expect(ws.name).toBe('Default Workspace');
    expect(wm.getDefault()).toBe(ws.id);
  });

  it('ensureDefault() is idempotent — returns the existing default on subsequent calls', () => {
    const first = wm.ensureDefault();
    const second = wm.ensureDefault();
    expect(second.id).toBe(first.id);
    expect(wm.list()).toHaveLength(1);
  });

  it('ensureDefault() falls back to the first workspace when no default pointer is set', () => {
    // Simulate an older installation: workspace created without setDefault().
    wm.create({ name: 'Pre-Existing', group: 'Personal' });
    const ws = wm.ensureDefault();
    expect(ws.name).toBe('Pre-Existing');
  });
});

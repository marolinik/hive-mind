import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiMindCache } from './multi-mind-cache.js';

describe('MultiMindCache', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hmind-mcache-'));
  });

  afterEach(() => {
    // Best-effort cleanup of any *.mind / sidecar files.
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function mindPathOf(id: string): string {
    return join(root, `${id}.mind`);
  }

  it('returns null when the getMindPath callback returns null', () => {
    const cache = new MultiMindCache({ maxOpen: 5, getMindPath: () => null });
    expect(cache.getOrOpen('nope')).toBeNull();
  });

  it('opens, caches, and returns the same MindDB on repeated calls', () => {
    const cache = new MultiMindCache({ maxOpen: 5, getMindPath: mindPathOf });
    const a = cache.getOrOpen('ws-1');
    const b = cache.getOrOpen('ws-1');
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(cache.size).toBe(1);
  });

  it('evicts the least-recently-used entry when at maxOpen', () => {
    // Stub Date.now so access timestamps are deterministic and monotonic —
    // otherwise four consecutive getOrOpen() calls can land in the same
    // millisecond and LRU order collapses to insertion order.
    const nowSpy = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    nowSpy.mockImplementation(() => (t += 10));

    try {
      const cache = new MultiMindCache({ maxOpen: 2, getMindPath: mindPathOf });
      cache.getOrOpen('a');    // insert a  @ t1
      cache.getOrOpen('b');    // insert b  @ t2
      cache.getOrOpen('a');    // touch a   @ t3 → b is now LRU
      const c = cache.getOrOpen('c'); // insert c, evict b
      expect(c).not.toBeNull();
      expect(cache.size).toBe(2);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('close() removes and closes a single workspace', () => {
    const cache = new MultiMindCache({ maxOpen: 5, getMindPath: mindPathOf });
    cache.getOrOpen('a');
    cache.getOrOpen('b');
    cache.close('a');
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  it('closeAll() drops every entry', () => {
    const cache = new MultiMindCache({ maxOpen: 5, getMindPath: mindPathOf });
    cache.getOrOpen('a');
    cache.getOrOpen('b');
    cache.closeAll();
    expect(cache.size).toBe(0);
    expect(cache.keys()).toEqual([]);
  });

  it('getIfOpen() returns the cached db without opening new ones', () => {
    const cache = new MultiMindCache({ maxOpen: 5, getMindPath: mindPathOf });
    expect(cache.getIfOpen('a')).toBeNull();
    cache.getOrOpen('a');
    expect(cache.getIfOpen('a')).not.toBeNull();
  });

  it('allowedRoot rejects paths that escape the root', () => {
    // Hostile workspaceId ⇢ an absolute path outside the configured sandbox.
    const outside = mkdtempSync(join(tmpdir(), 'hmind-outside-'));
    const hostilePath = join(outside, 'rogue.mind');

    const cache = new MultiMindCache({
      maxOpen: 5,
      allowedRoot: root,
      getMindPath: (id) => (id === 'rogue' ? hostilePath : mindPathOf(id)),
    });

    expect(cache.getOrOpen('rogue')).toBeNull();
    expect(cache.size).toBe(0);
    // Clean up the sandbox-escape directory.
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('allowedRoot accepts paths inside the root (including root itself)', () => {
    const cache = new MultiMindCache({
      maxOpen: 5,
      allowedRoot: root,
      getMindPath: mindPathOf,
    });
    const db = cache.getOrOpen('inside');
    expect(db).not.toBeNull();
    expect(existsSync(mindPathOf('inside'))).toBe(true);
  });
});

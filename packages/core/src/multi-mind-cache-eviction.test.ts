import { describe, it, expect } from 'vitest';
import { MultiMindCache } from './multi-mind-cache.js';
import { FrameStore } from './mind/frames.js';
import { SessionStore } from './mind/sessions.js';

/**
 * Regression + fix coverage for the DB-flake root cause: MultiMindCache used to
 * close (evict) a MindDB that a live chat turn was still holding across the LLM
 * await, surfacing as a swallowed "database connection is not open" write.
 *
 * DIRECT SQLITE only — no embedder / vector search (CI-substrate-smoke rule).
 * Each workspace maps to its own in-memory DB; FTS5 (via createIFrame → indexFts)
 * is fine. A gop row is seeded via SessionStore.ensure() to satisfy the frame FK.
 */
function makeCache(maxOpen: number): MultiMindCache {
  // Every id opens a fresh :memory: DB; the cache keeps one handle per id until
  // it is evicted or closed. allowedRoot is left unset (no path guard needed).
  return new MultiMindCache({ maxOpen, getMindPath: () => ':memory:' });
}

describe('MultiMindCache eviction / session-pinning', () => {
  it('REGRESSION: an unpinned in-use mind is evicted + closed under pressure', () => {
    const cache = makeCache(2);
    const dbA = cache.getOrOpen('A');
    expect(dbA).not.toBeNull();

    new SessionStore(dbA!).ensure('gop-1');
    const frameId = new FrameStore(dbA!).createIFrame('gop-1', 'hello from A').id;

    // Fan-out pressure: B fills the cap, C forces an eviction. A is the LRU and
    // is UNPINNED, so it is the victim — exactly the flake trigger.
    cache.getOrOpen('B');
    cache.getOrOpen('C');

    expect(cache.has('A')).toBe(false); // A was evicted
    // The handle the "session" still holds is now closed → any read throws.
    expect(() => new FrameStore(dbA!).getById(frameId)).toThrow(/not open/i);

    cache.closeAll();
  });

  it('FIX: acquire() pins a mind so eviction skips it and picks an unpinned victim', () => {
    const cache = makeCache(2);
    const dbA = cache.acquire('A'); // pinned for the session lifetime

    new SessionStore(dbA).ensure('gop-1');
    const frameId = new FrameStore(dbA).createIFrame('gop-1', 'hello pinned').id;

    // Same pressure as the regression case. B (unpinned) must be the victim; A
    // (pinned) must survive even though it is the LRU by access time.
    cache.getOrOpen('B');
    cache.getOrOpen('C');

    expect(cache.has('A')).toBe(true);  // pinned mind survived
    expect(cache.has('B')).toBe(false); // an unpinned entry was evicted instead

    // A's handle is still live — read via the reference we already hold (do NOT
    // touch the cache, so A stays the LRU for the release assertion below).
    const row = new FrameStore(dbA).getById(frameId);
    expect(row?.id).toBe(frameId);

    // Releasing the pin makes A evictable again.
    cache.release('A');
    cache.getOrOpen('D'); // fresh pressure now that A is unpinned
    expect(cache.has('A')).toBe(false);

    cache.closeAll();
  });

  it('REOPEN-GUARD: a handle closed out-of-band is transparently reopened', () => {
    const cache = makeCache(2);
    const dbA = cache.getOrOpen('A');
    expect(dbA).not.toBeNull();

    // Simulate one of the extra close seams closing the underlying handle while
    // the entry is still in the cache map.
    dbA!.close();
    expect(dbA!.isOpen()).toBe(false);

    const reopened = cache.getOrOpen('A');
    expect(reopened).not.toBeNull();
    expect(reopened!.isOpen()).toBe(true);
    expect(reopened).not.toBe(dbA); // a fresh, live handle
    // The reopened handle is usable (empty DB → getById returns undefined, no throw).
    expect(() => new FrameStore(reopened!).getById(1)).not.toThrow();

    cache.closeAll();
  });
});

import path from 'node:path';
import { MindDB } from './mind/db.js';
import { createCoreLogger } from './logger.js';

const log = createCoreLogger('multi-mind-cache');

export interface MultiMindCacheConfig {
  maxOpen: number;
  getMindPath: (workspaceId: string) => string | null;
  /**
   * Defense-in-depth root directory. If set, `getOrOpen` rejects any path that
   * does not resolve to a descendant of this root. Prevents a crafted
   * workspaceId like '../../other-user.mind' from opening an arbitrary file
   * via the caller-supplied `getMindPath`.
   */
  allowedRoot?: string;
}

interface CacheEntry {
  db: MindDB;
  lastAccessed: number;
  /**
   * Session-lifetime refcount. Incremented by `acquire()` when a workspace
   * session borrows the handle, decremented by `release()` on session close.
   * `evictLRU` never closes an entry with `pins > 0` — a pinned mind is in use
   * by a live session that may write to it across an LLM await, and closing it
   * mid-turn caused the swallowed "database connection is not open" flake.
   */
  pins: number;
}

/**
 * LRU cache of open MindDB handles keyed by workspace ID.
 * Opens minds on demand and evicts the least recently used when full.
 */
export class MultiMindCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxOpen: number;
  private readonly getMindPath: (workspaceId: string) => string | null;
  private readonly allowedRoot: string | null;

  constructor(config: MultiMindCacheConfig) {
    this.maxOpen = config.maxOpen;
    this.getMindPath = config.getMindPath;
    this.allowedRoot = config.allowedRoot ? path.resolve(config.allowedRoot) : null;
  }

  getOrOpen(workspaceId: string): MindDB | null {
    const existing = this.cache.get(workspaceId);
    let carriedPins = 0;
    if (existing) {
      // Reopen-guard: normally hand back the cached handle. But if it was closed
      // out-of-band (an explicit close() seam ran while a session still held a
      // reference), drop the dead entry and reopen below — carrying the pin count
      // forward so an in-use mind stays eviction-protected after the reopen.
      if (existing.db.isOpen()) {
        existing.lastAccessed = Date.now();
        return existing.db;
      }
      carriedPins = existing.pins;
      this.cache.delete(workspaceId);
    }

    const mindPath = this.getMindPath(workspaceId);
    if (!mindPath) return null;

    // Path-traversal guard. Defense-in-depth against an attacker-controlled
    // workspaceId (e.g. from an LLM tool call with a misconfigured approval
    // gate) that resolves to an arbitrary filesystem path.
    if (this.allowedRoot) {
      const resolved = path.resolve(mindPath);
      if (resolved !== this.allowedRoot && !resolved.startsWith(this.allowedRoot + path.sep)) {
        log.warn('path outside allowedRoot — rejecting getOrOpen', {
          workspaceId,
          resolvedPath: resolved,
        });
        return null;
      }
    }

    // Race re-check after evictLRU — a concurrent call may have just
    // inserted the same workspaceId between our initial .get() and here.
    try {
      if (this.cache.size >= this.maxOpen) {
        this.evictLRU();
      }
      const recheck = this.cache.get(workspaceId);
      if (recheck && recheck.db.isOpen()) {
        recheck.lastAccessed = Date.now();
        return recheck.db;
      }
      const db = new MindDB(mindPath);
      this.cache.set(workspaceId, { db, lastAccessed: Date.now(), pins: carriedPins });
      return db;
    } catch (err) {
      log.warn('failed to open MindDB', { workspaceId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  getIfOpen(workspaceId: string): MindDB | null {
    const entry = this.cache.get(workspaceId);
    if (entry) {
      entry.lastAccessed = Date.now();
      return entry.db;
    }
    return null;
  }

  /**
   * Borrow a MindDB handle for the lifetime of a workspace session and pin it
   * so `evictLRU` cannot close it while the session is live. The cache remains
   * the sole owner of the handle — the borrower must NOT call `.close()` on it;
   * it calls `release()` exactly once when the session closes. Throws if the
   * mind cannot be opened (callers pre-check via `getOrOpen`, so this is the
   * unreachable-path guard, not a normal control-flow branch).
   */
  acquire(workspaceId: string): MindDB {
    const db = this.getOrOpen(workspaceId);
    if (!db) throw new Error(`MultiMindCache.acquire: cannot open mind for workspace '${workspaceId}'`);
    const entry = this.cache.get(workspaceId);
    if (entry) entry.pins += 1;
    return db;
  }

  /**
   * Release a session's pin on a workspace mind. Floors at 0 so a stray extra
   * release (e.g. a failed session create that never actually pinned) can never
   * drive the refcount negative and wrongly un-pin a still-live session.
   */
  release(workspaceId: string): void {
    const entry = this.cache.get(workspaceId);
    if (entry && entry.pins > 0) entry.pins -= 1;
  }

  has(workspaceId: string): boolean {
    return this.cache.has(workspaceId);
  }

  close(workspaceId: string): void {
    const entry = this.cache.get(workspaceId);
    if (entry) {
      try { entry.db.close(); } catch (err) { log.warn('close failed', { workspaceId, error: err instanceof Error ? err.message : String(err) }); }
      this.cache.delete(workspaceId);
    }
  }

  closeAll(): void {
    for (const [id, entry] of this.cache) {
      try { entry.db.close(); } catch (err) { log.warn('close failed', { workspaceId: id, error: err instanceof Error ? err.message : String(err) }); }
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  keys(): string[] {
    return [...this.cache.keys()];
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.pins > 0) continue; // never evict a mind pinned by a live session
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.close(oldestKey);
    } else {
      // Every open mind is pinned by an active session. Closing one would poison
      // an in-flight chat turn, so we accept exceeding the soft cap instead
      // (correctness over the maxOpen limit). The map shrinks again as sessions
      // release their pins.
      log.warn('evictLRU: all cached minds pinned by active sessions — exceeding maxOpen', {
        size: this.cache.size,
        maxOpen: this.maxOpen,
      });
    }
  }
}

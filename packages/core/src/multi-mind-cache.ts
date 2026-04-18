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
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing.db;
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
      if (recheck) {
        recheck.lastAccessed = Date.now();
        return recheck.db;
      }
      const db = new MindDB(mindPath);
      this.cache.set(workspaceId, { db, lastAccessed: Date.now() });
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
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.close(oldestKey);
    }
  }
}

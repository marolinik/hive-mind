/**
 * Compilation State Tracker — SQLite-backed watermarks and page hashes.
 *
 * Tracks what has been compiled and when, enabling incremental compilation.
 * Uses the same MindDB instance as the memory system.
 */

import { createHash } from 'node:crypto';
import type { MindDB } from '@hive-mind/core';
import type { WikiPageType, CompilationWatermark, PageRecord } from './types.js';

const PAGES_TABLE = `
CREATE TABLE IF NOT EXISTS wiki_pages (
  slug TEXT PRIMARY KEY,
  page_type TEXT NOT NULL,
  name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  markdown TEXT NOT NULL DEFAULT '',
  frame_ids TEXT NOT NULL DEFAULT '[]',
  compiled_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_count INTEGER NOT NULL DEFAULT 0
)`;

const WATERMARK_TABLE = `
CREATE TABLE IF NOT EXISTS wiki_watermark (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_frame_id INTEGER NOT NULL DEFAULT 0,
  last_compiled_at TEXT NOT NULL DEFAULT (datetime('now')),
  pages_compiled INTEGER NOT NULL DEFAULT 0
)`;

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export class CompilationState {
  private db: MindDB;

  constructor(db: MindDB) {
    this.db = db;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const raw = this.db.getDatabase();
    raw.prepare(PAGES_TABLE).run();
    raw.prepare(WATERMARK_TABLE).run();
    // Migration: add markdown column if missing (for databases created before v1.1)
    try {
      raw.prepare("SELECT markdown FROM wiki_pages LIMIT 0").get();
    } catch {
      raw.prepare("ALTER TABLE wiki_pages ADD COLUMN markdown TEXT NOT NULL DEFAULT ''").run();
    }
  }

  // ── Watermark ─────────────────────────────────────────────────

  getWatermark(): CompilationWatermark {
    const raw = this.db.getDatabase();
    const row = raw.prepare('SELECT * FROM wiki_watermark WHERE id = 1').get() as {
      last_frame_id: number;
      last_compiled_at: string;
      pages_compiled: number;
    } | undefined;

    if (!row) {
      return { lastFrameId: 0, lastCompiledAt: '', pagesCompiled: 0 };
    }

    return {
      lastFrameId: row.last_frame_id,
      lastCompiledAt: row.last_compiled_at,
      pagesCompiled: row.pages_compiled,
    };
  }

  updateWatermark(lastFrameId: number, pagesCompiled: number): void {
    const raw = this.db.getDatabase();
    raw.prepare(`
      INSERT INTO wiki_watermark (id, last_frame_id, last_compiled_at, pages_compiled)
      VALUES (1, ?, datetime('now'), ?)
      ON CONFLICT(id) DO UPDATE SET
        last_frame_id = excluded.last_frame_id,
        last_compiled_at = excluded.last_compiled_at,
        pages_compiled = excluded.pages_compiled
    `).run(lastFrameId, pagesCompiled);
  }

  // ── Page Records ──────────────────────────────────────────────

  getPage(slug: string): PageRecord | undefined {
    return this.db.getDatabase().prepare(
      'SELECT slug, page_type as pageType, name, content_hash as contentHash, markdown, frame_ids as frameIds, compiled_at as compiledAt, source_count as sourceCount FROM wiki_pages WHERE slug = ?',
    ).get(slug) as PageRecord | undefined;
  }

  getAllPages(): PageRecord[] {
    return this.db.getDatabase().prepare(
      'SELECT slug, page_type as pageType, name, content_hash as contentHash, markdown, frame_ids as frameIds, compiled_at as compiledAt, source_count as sourceCount FROM wiki_pages ORDER BY name',
    ).all() as PageRecord[];
  }

  getPagesByType(pageType: WikiPageType): PageRecord[] {
    return this.db.getDatabase().prepare(
      'SELECT slug, page_type as pageType, name, content_hash as contentHash, markdown, frame_ids as frameIds, compiled_at as compiledAt, source_count as sourceCount FROM wiki_pages WHERE page_type = ? ORDER BY name',
    ).all(pageType) as PageRecord[];
  }

  upsertPage(
    slug: string,
    pageType: WikiPageType,
    name: string,
    hash: string,
    frameIds: number[],
    sourceCount: number,
    markdown = '',
  ): { action: 'created' | 'updated' | 'unchanged' } {
    const raw = this.db.getDatabase();
    const existing = this.getPage(slug);

    if (existing && existing.contentHash === hash) {
      return { action: 'unchanged' };
    }

    raw.prepare(`
      INSERT INTO wiki_pages (slug, page_type, name, content_hash, markdown, frame_ids, compiled_at, source_count)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(slug) DO UPDATE SET
        content_hash = excluded.content_hash,
        markdown = excluded.markdown,
        frame_ids = excluded.frame_ids,
        compiled_at = excluded.compiled_at,
        source_count = excluded.source_count
    `).run(slug, pageType, name, hash, markdown, JSON.stringify(frameIds), sourceCount);

    return { action: existing ? 'updated' : 'created' };
  }

  deletePage(slug: string): boolean {
    const result = this.db.getDatabase().prepare(
      'DELETE FROM wiki_pages WHERE slug = ?',
    ).run(slug);
    return result.changes > 0;
  }

  /** Get the highest frame ID in the database. */
  getMaxFrameId(): number {
    const row = this.db.getDatabase().prepare(
      'SELECT COALESCE(MAX(id), 0) as max_id FROM memory_frames',
    ).get() as { max_id: number };
    return row.max_id;
  }

  /** Get frames newer than a given ID. */
  getFramesSince(frameId: number, limit = 500): { id: number; content: string; importance: string; source: string; created_at: string }[] {
    return this.db.getDatabase().prepare(
      'SELECT id, content, importance, source, created_at FROM memory_frames WHERE id > ? ORDER BY id ASC LIMIT ?',
    ).all(frameId, limit) as { id: number; content: string; importance: string; source: string; created_at: string }[];
  }
}

/**
 * HybridSearch — Reciprocal Rank Fusion over FTS5 + sqlite-vec.
 *
 * Runs keyword and vector searches in parallel, fuses their rankings via RRF
 * (reciprocal-rank-fusion, k=60), then multiplies each candidate's RRF score
 * by a personalization relevance score (see scoring.ts) to produce the final
 * ranking. The two layers are intentionally separable: IR quality (RRF) is
 * independent of personalization tuning (scoring profile).
 *
 * Extracted from Waggle OS `packages/core/src/mind/search.ts`.
 * Scrub: dropped unused `ScoredResult` import (hive-mind tsconfig enables
 * `noUnusedLocals`).
 */

import type { MindDB } from './db.js';
import type { Embedder } from './embeddings.js';
import type { MemoryFrame, Importance } from './frames.js';
import {
  computeRelevance,
  SCORING_PROFILES,
  type ScoringProfile,
  type ScoringContext,
} from './scoring.js';

export interface SearchOptions {
  limit?: number;
  gopId?: string;
  profile?: ScoringProfile;
  context?: ScoringContext;
  /** Only include frames created on or after this ISO date string. */
  since?: string;
  /** Only include frames created on or before this ISO date string. */
  until?: string;
}

export interface SearchResult {
  frame: MemoryFrame;
  rrfScore: number;
  relevanceScore: number;
  finalScore: number;
}

const RRF_K = 60;

function f32ToBlob(f32: Float32Array): Uint8Array {
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

export class HybridSearch {
  private db: MindDB;
  private embedder: Embedder;

  constructor(db: MindDB, embedder: Embedder) {
    this.db = db;
    this.embedder = embedder;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 20, gopId, profile = 'balanced', context = {}, since, until } = options;
    const weights = SCORING_PROFILES[profile];

    const [keywordResults, vectorResults] = await Promise.all([
      this.keywordSearch(query, limit * 2, gopId),
      this.vectorSearch(query, limit * 2, gopId),
    ]);

    // RRF fusion.
    const rrfScores = new Map<number, number>();

    keywordResults.forEach((id, rank) => {
      rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank));
    });

    vectorResults.forEach((id, rank) => {
      rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank));
    });

    const frameIds = [...rrfScores.keys()];
    if (frameIds.length === 0) return [];

    const raw = this.db.getDatabase();
    const placeholders = frameIds.map(() => '?').join(',');
    const temporalConditions: string[] = [];
    const temporalParams: unknown[] = [...frameIds];

    if (since) {
      temporalConditions.push('created_at >= ?');
      temporalParams.push(since);
    }
    if (until) {
      temporalConditions.push('created_at <= ?');
      temporalParams.push(until);
    }

    const whereExtra =
      temporalConditions.length > 0 ? ` AND ${temporalConditions.join(' AND ')}` : '';

    const frames = raw
      .prepare(
        `SELECT * FROM memory_frames WHERE id IN (${placeholders})${whereExtra}`,
      )
      .all(...temporalParams) as MemoryFrame[];

    const frameMap = new Map(frames.map((f) => [f.id, f]));

    const results: SearchResult[] = [];
    for (const [frameId, rrfScore] of rrfScores) {
      const frame = frameMap.get(frameId);
      if (!frame) continue;

      const relevanceScore = computeRelevance(
        {
          id: frame.id,
          last_accessed: frame.last_accessed,
          access_count: frame.access_count,
          importance: frame.importance as Importance,
        },
        weights,
        context,
      );

      results.push({
        frame,
        rrfScore,
        relevanceScore,
        finalScore: rrfScore * relevanceScore,
      });
    }

    results.sort((a, b) => b.finalScore - a.finalScore);
    return results.slice(0, limit);
  }

  async keywordSearch(query: string, limit: number, gopId?: string): Promise<number[]> {
    const raw = this.db.getDatabase();

    // Sanitize query for FTS5 with OR-based matching for better recall. Strips
    // punctuation, drops stop words, and quotes each remaining token. This
    // trades a small precision drop for much better recall on natural-language
    // queries (e.g. "hiring decisions this month" → `"hiring" OR "decisions" OR "month"`).
    const FTS_STOP_WORDS = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'this',
      'that', 'these', 'those', 'it', 'its', 'my', 'your', 'our', 'their',
      'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'all',
      'each', 'every', 'both', 'some', 'any', 'no', 'not', 'and', 'or', 'but',
    ]);
    const safeQuery = query.includes('"')
      ? query // already quoted by caller
      : query
          .split(/\s+/)
          .map((w) => w.replace(/[^\w]/g, ''))
          .filter((w) => w.length > 2 && !FTS_STOP_WORDS.has(w.toLowerCase()))
          .map((w) => `"${w.replace(/"/g, '')}"`)
          .join(' OR ');

    if (!safeQuery) return [];

    let sql: string;
    let params: unknown[];

    if (gopId) {
      sql = `
        SELECT mf.id FROM memory_frames_fts fts
        JOIN memory_frames mf ON mf.id = fts.rowid
        WHERE fts.content MATCH ? AND mf.gop_id = ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [safeQuery, gopId, limit];
    } else {
      sql = `
        SELECT rowid as id FROM memory_frames_fts
        WHERE content MATCH ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [safeQuery, limit];
    }

    try {
      const rows = raw.prepare(sql).all(...params) as { id: number }[];
      return rows.map((r) => r.id);
    } catch {
      // FTS5 parse error — return empty; callers can fall back to alternative strategies.
      return [];
    }
  }

  async vectorSearch(query: string, limit: number, gopId?: string): Promise<number[]> {
    const embedding = await this.embedder.embed(query);
    const blob = f32ToBlob(embedding);
    const raw = this.db.getDatabase();

    if (gopId) {
      try {
        const rows = raw
          .prepare(
            `SELECT v.rowid as id FROM memory_frames_vec v
             WHERE v.embedding MATCH ? AND k = ?
             ORDER BY distance`,
          )
          .all(blob, limit * 3) as { id: number }[];

        if (rows.length === 0) return [];
        const placeholders = rows.map(() => '?').join(',');
        const filtered = raw
          .prepare(
            `SELECT id FROM memory_frames WHERE id IN (${placeholders}) AND gop_id = ?`,
          )
          .all(...rows.map((r) => r.id), gopId) as { id: number }[];

        return filtered.map((r) => r.id).slice(0, limit);
      } catch {
        return [];
      }
    } else {
      try {
        const rows = raw
          .prepare(
            `SELECT rowid as id FROM memory_frames_vec
             WHERE embedding MATCH ? AND k = ?
             ORDER BY distance`,
          )
          .all(blob, limit) as { id: number }[];
        return rows.map((r) => r.id);
      } catch {
        return [];
      }
    }
  }

  async indexFrame(frameId: number, content: string): Promise<void> {
    if (!Number.isFinite(frameId)) {
      throw new Error('Invalid frame ID for vector indexing');
    }
    const embedding = await this.embedder.embed(content);
    const raw = this.db.getDatabase();
    // sqlite-vec vec0 requires rowid as SQL literal (parameterized rowid not supported).
    const id = Math.trunc(frameId);
    raw
      .prepare(`INSERT INTO memory_frames_vec (rowid, embedding) VALUES (${id}, ?)`)
      .run(f32ToBlob(embedding));
  }

  async indexFramesBatch(frames: { id: number; content: string }[]): Promise<void> {
    if (frames.length === 0) return;
    for (const f of frames) {
      if (!Number.isFinite(f.id)) {
        throw new Error('Invalid frame ID for vector indexing');
      }
    }
    const contents = frames.map((f) => f.content);
    const embeddings = await this.embedder.embedBatch(contents);
    const raw = this.db.getDatabase();
    // sqlite-vec vec0 requires rowid as SQL literal (parameterized rowid not supported).
    const insertAll = raw.transaction(() => {
      for (let i = 0; i < frames.length; i++) {
        const id = Math.trunc(frames[i].id);
        raw
          .prepare(`INSERT INTO memory_frames_vec (rowid, embedding) VALUES (${id}, ?)`)
          .run(f32ToBlob(embeddings[i]));
      }
    });
    insertAll();
  }
}

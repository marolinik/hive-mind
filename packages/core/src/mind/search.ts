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
import type { Reranker } from './inprocess-reranker.js';
import { createCoreLogger } from '../logger.js';
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
  /**
   * Cross-encoder reranker invoked AFTER RRF on the top-`rerankPoolSize`
   * candidates. When provided, results are sorted by reranker score
   * instead of finalScore. RRF + relevance still rank the candidate
   * pool; the reranker only re-orders the survivors.
   */
  reranker?: Reranker;
  /** How many candidates to send to the reranker (default 30). */
  rerankPoolSize?: number;
}

export interface SearchResult {
  frame: MemoryFrame;
  rrfScore: number;
  relevanceScore: number;
  finalScore: number;
}

const RRF_K = 60;

const log = createCoreLogger('search');

function f32ToBlob(f32: Float32Array): Uint8Array {
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

export class HybridSearch {
  private db: MindDB;
  private embedder: Embedder;

  /** Memoized once a successful fingerprint check has run. A failing check
   *  (dim mismatch) leaves this false so it re-throws on every call. */
  private fingerprintChecked = false;

  constructor(db: MindDB, embedder: Embedder) {
    this.db = db;
    this.embedder = embedder;
  }

  /**
   * Guard the embedding dimension before any vector read/write. Records the
   * {provider, model, dim} fingerprint on first use; throws
   * EmbeddingDimMismatchError if the active embedder's dim differs from what
   * the .mind's vectors were written at; warns (but allows) on a same-dim model
   * change. Memoized on success so it costs one meta read per instance lifetime.
   * Must be called BEFORE any try/catch that would swallow the error.
   */
  private ensureFingerprint(): void {
    if (this.fingerprintChecked) return;
    const e = this.embedder as Embedder & {
      getActiveProvider?(): string;
      getStatus?(): { modelName?: string };
    };
    const provider = e.getActiveProvider?.() ?? 'unknown';
    const model = e.getStatus?.().modelName ?? 'unknown';
    const result = this.db.ensureEmbeddingFingerprint({ provider, model, dim: this.embedder.dimensions });
    // Only memoize after a non-throwing check (a dim mismatch must keep throwing).
    this.fingerprintChecked = true;
    if (result.status === 'model-changed') {
      log.warn(
        `Embedding model changed for this .mind (${result.storedProvider}/${result.storedModel} → ` +
          `${provider}/${model}, same ${this.embedder.dimensions}-dim). Existing vectors stay searchable, ` +
          `but cross-model similarity is degraded — consider \`hive-mind maintenance --reembed-all\`.`,
      );
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 20, gopId, profile = 'balanced', context = {}, since, until } = options;
    const weights = SCORING_PROFILES[profile];

    // Prefer chunk-level vector search when chunks_vec is populated:
    // discriminates better on domain-homogeneous corpora than whole-frame
    // embeddings. vectorSearchChunks returns null when no chunks exist,
    // signalling clean fallback to the whole-frame path. Both paths return
    // frame IDs so the rest of the RRF + scoring pipeline is unchanged.
    const chunkResults = await this.vectorSearchChunks(query, limit * 2, gopId);
    const [keywordResults, vectorResults] = await Promise.all([
      this.keywordSearch(query, limit * 2, gopId),
      chunkResults !== null ? Promise.resolve(chunkResults) : this.vectorSearch(query, limit * 2, gopId),
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

    // Optional cross-encoder reranking on the top pool. Reranker scoring
    // is jointly attentive over (query, doc), so it discriminates much
    // better than vector dot products on densely-homogeneous corpora.
    // We rerank the survivors only — RRF still selects the candidate pool.
    if (options.reranker) {
      const poolSize = Math.min(options.rerankPoolSize ?? 30, results.length);
      const pool = results.slice(0, poolSize);
      try {
        const docs = pool.map((r) => r.frame.content);
        const scores = await options.reranker.scoreBatch(query, docs);
        // Pair (result, rerank score), sort desc, replace finalScore so the
        // shape stays the same for downstream consumers.
        const reranked = pool.map((r, i) => ({ ...r, finalScore: scores[i] }));
        reranked.sort((a, b) => b.finalScore - a.finalScore);
        // Append any pool tail items beyond rerankPoolSize so a small limit
        // doesn't suddenly contract the result set.
        return reranked.concat(results.slice(poolSize)).slice(0, limit);
      } catch {
        // Reranker failure (model load, OOM, dim mismatch) — fall back to
        // RRF ordering. Soft-fail so a misconfigured reranker doesn't
        // kill recall_memory entirely.
      }
    }

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
    this.ensureFingerprint();
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
    this.ensureFingerprint();
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
    this.ensureFingerprint();
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

  // ── Chunk-level indexing (Phase 3b-3 chunking) ─────────────────────────
  // Whole-frame embeddings cluster too tightly on a domain-homogeneous
  // corpus (every frame is "about hive-mind"), so retrieval can't
  // discriminate. Chunking decomposes a frame into ~500-token paragraph-
  // level pieces, each with its own embedding — search returns the chunk,
  // we map back to the parent frame for the final result.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Replace all chunks for a frame: clears existing chunks/vec rows for the
   * frame, re-chunks the content, embeds each chunk, inserts both rows.
   * Idempotent — safe to call repeatedly. Used by --rechunk-all migration.
   */
  async indexChunksForFrame(
    frameId: number,
    content: string,
    opts: { maxChars?: number; overlapChars?: number; minChunkChars?: number } = {},
  ): Promise<number> {
    if (!Number.isFinite(frameId) || frameId <= 0) {
      throw new Error('Invalid frame ID for chunk indexing');
    }
    this.ensureFingerprint();
    const raw = this.db.getDatabase();
    const id = Math.trunc(frameId);

    // Lazy import to keep search.ts free of cycle risk.
    const { chunkText } = await import('./chunker.js');
    const chunks = chunkText(content, opts);
    if (chunks.length === 0) return 0;

    // Embed all chunks. Use embedBatch when the embedder supports it for
    // amortised HTTP overhead on Ollama/API providers.
    const texts = chunks.map((c) => c.text);
    const embeddings = await this.embedder.embedBatch(texts);

    // Single tx so partial failure leaves the frame's chunks empty
    // (next rechunk pass will re-fill from scratch — same end state).
    const tx = raw.transaction(() => {
      // Find existing chunk_ids for this frame so we can drop their vec rows.
      // Foreign-key cascade handles memory_frame_chunks deletion when the
      // parent frame is deleted, but for re-indexing we're keeping the
      // frame and just replacing its chunks.
      const existing = raw
        .prepare('SELECT id FROM memory_frame_chunks WHERE frame_id = ?')
        .all(id) as Array<{ id: number }>;
      for (const row of existing) {
        // sqlite-vec rowid must be SQL literal.
        raw.prepare(`DELETE FROM memory_frame_chunks_vec WHERE rowid = ${Math.trunc(row.id)}`).run();
      }
      raw.prepare('DELETE FROM memory_frame_chunks WHERE frame_id = ?').run(id);

      const insertChunk = raw.prepare(
        'INSERT INTO memory_frame_chunks (frame_id, chunk_idx, content, char_start, char_end) VALUES (?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const result = insertChunk.run(id, i, c.text, c.charStart, c.charEnd);
        const chunkId = Math.trunc(Number(result.lastInsertRowid));
        raw
          .prepare(`INSERT INTO memory_frame_chunks_vec (rowid, embedding) VALUES (${chunkId}, ?)`)
          .run(f32ToBlob(embeddings[i]));
      }
    });
    tx();
    return chunks.length;
  }

  /**
   * Vector search over chunks. Returns parent frame IDs deduped (best-chunk-
   * per-frame wins). When chunks_vec is empty, returns null so callers can
   * cleanly fall back to the whole-frame vectorSearch path.
   */
  async vectorSearchChunks(query: string, limit: number, gopId?: string): Promise<number[] | null> {
    this.ensureFingerprint();
    const raw = this.db.getDatabase();
    // Cheap probe — avoid embedding the query when chunks aren't populated.
    let chunkCount: number;
    try {
      const row = raw.prepare('SELECT COUNT(*) AS n FROM memory_frame_chunks').get() as
        | { n: number }
        | undefined;
      chunkCount = row?.n ?? 0;
    } catch {
      return null;
    }
    if (chunkCount === 0) return null;

    const embedding = await this.embedder.embed(query);
    const blob = f32ToBlob(embedding);

    // Over-fetch chunks (limit * 5) so dedup-to-frame still leaves enough
    // candidates after collapsing multiple chunks of the same frame.
    try {
      const chunkRows = raw
        .prepare(
          `SELECT v.rowid AS chunk_id, c.frame_id
             FROM memory_frame_chunks_vec v
             JOIN memory_frame_chunks c ON c.id = v.rowid
            WHERE v.embedding MATCH ? AND k = ?
            ORDER BY distance`,
        )
        .all(blob, Math.max(limit * 5, 25)) as Array<{ chunk_id: number; frame_id: number }>;

      if (chunkRows.length === 0) return [];

      // Dedup by frame_id, preserving first-seen order (best-distance chunk).
      const seen = new Set<number>();
      const frameIds: number[] = [];
      for (const r of chunkRows) {
        if (seen.has(r.frame_id)) continue;
        seen.add(r.frame_id);
        frameIds.push(r.frame_id);
        if (frameIds.length >= limit) break;
      }

      if (gopId) {
        const placeholders = frameIds.map(() => '?').join(',');
        const filtered = raw
          .prepare(
            `SELECT id FROM memory_frames WHERE id IN (${placeholders}) AND gop_id = ?`,
          )
          .all(...frameIds, gopId) as { id: number }[];
        return filtered.map((r) => r.id).slice(0, limit);
      }
      return frameIds;
    } catch {
      return null;
    }
  }
}

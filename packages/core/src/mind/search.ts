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
import { chunkText, type ChunkOptions } from './chunker.js';
import { createCoreLogger } from '../logger.js';
import {
  computeRelevance,
  SCORING_PROFILES,
  type ScoringProfile,
  type ScoringContext,
} from './scoring.js';
import { KnowledgeGraph } from './knowledge.js';

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

/**
 * Retrieval-confidence verdict for the abstain path (LongMemEval's
 * "insufficient evidence" ability). Pure + side-effect-free so callers
 * (MCP recall_memory, CLI, eval harness) can decide whether to answer or
 * abstain without re-running search.
 */
export interface RetrievalConfidence {
  /** True when the top result clears the threshold (safe to answer). */
  sufficient: boolean;
  /** The top finalScore observed (0 when there were no results). */
  topScore: number;
  /** The threshold it was compared against. */
  threshold: number;
}

/**
 * Assess whether a result set carries enough signal to answer, or whether the
 * caller should abstain ("insufficient evidence"). A scaffold for the abstain
 * path: it does NOT change `search()` output — callers opt in by passing the
 * results plus a τ threshold. `sufficient` is true iff the top finalScore is
 * strictly greater than τ; an empty set is always insufficient.
 *
 * Threshold semantics intentionally mirror the recall-stress edge-query rule
 * (a low top score means "nothing relevant surfaced").
 */
export function assessRetrievalConfidence(
  results: readonly SearchResult[],
  threshold: number,
): RetrievalConfidence {
  const topScore = results.length ? results[0].finalScore : 0;
  return { sufficient: topScore > threshold, topScore, threshold };
}

const RRF_K = 60;

const log = createCoreLogger('search');

// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
/**
 * Chunk-level retrieval flag — DEFAULT ON. Gates BOTH the write side
 * (indexFrame / indexFramesBatch also chunk-index the frame) and the read
 * side (search() queries memory_frame_chunks_vec, falling back to whole-frame
 * vectors while the chunk index is empty). Kill switch:
 * HIVE_MIND_CHUNK_RETRIEVAL=0. `indexChunksForFrame` / `rechunkAllFrames`
 * stay callable regardless of the flag (backfill + eval + `hive-mind
 * maintenance --rechunk-all`).
 */
export function chunkRetrievalEnabled(): boolean {
  return process.env.HIVE_MIND_CHUNK_RETRIEVAL !== '0';
}

function f32ToBlob(f32: Float32Array): Uint8Array {
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Escape LIKE metacharacters (`%`, `_`) and the escape char itself (`\`) so the
 * keyword-fallback term is matched literally. Pair with `ESCAPE '\'` on the LIKE.
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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

    // Slot-consumption fix (forward-ported from waggle-os monorepo,
    // mono-parity 2026-06-12): the since/until filter applies AFTER the
    // lanes run (as a WHERE over candidate ids), so out-of-window candidates
    // would otherwise consume lane slots and shrink results below `limit`
    // even when in-window frames exist deeper in the lanes. Over-fetch the
    // lanes when a temporal window is active so the post-filter has depth.
    const laneFetch = since || until ? limit * 10 : limit * 2;

    // Prefer chunk-level vector search when the flag is on AND chunks_vec is
    // populated: discriminates better on domain-homogeneous corpora than
    // whole-frame embeddings. vectorSearchChunks returns null when no chunks
    // exist, signalling clean fallback to the whole-frame path. Both paths
    // return frame IDs so the rest of the RRF + scoring pipeline is
    // unchanged. Flag off → chunkResults is null without touching the chunk
    // tables.
    const chunkResults = chunkRetrievalEnabled()
      ? await this.vectorSearchChunks(query, laneFetch, gopId)
      : null;
    const [keywordResults, vectorResults] = await Promise.all([
      this.keywordSearch(query, laneFetch, gopId),
      chunkResults !== null ? Promise.resolve(chunkResults) : this.vectorSearch(query, laneFetch, gopId),
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

    // Fencepost fix (forward-ported from waggle-os monorepo, mono-parity
    // 2026-06-12): `created_at` carries mixed formats across write paths —
    // `datetime('now')` ("YYYY-MM-DD HH:MM:SS") vs harvest ISO
    // ("YYYY-MM-DDT…Z"). A date-only `until` string-compares BELOW any
    // same-day timestamp ("2026-03-21T10:00" > "2026-03-21"), silently
    // excluding the whole final day. Compare date-only bounds on the
    // 10-char date prefix instead — format-agnostic and inclusive.
    if (since) {
      if (since.length === 10) {
        temporalConditions.push('substr(created_at, 1, 10) >= ?');
      } else {
        temporalConditions.push('created_at >= ?');
      }
      temporalParams.push(since);
    }
    if (until) {
      if (until.length === 10) {
        temporalConditions.push('substr(created_at, 1, 10) <= ?');
      } else {
        temporalConditions.push('created_at <= ?');
      }
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

    // Turn on the 'contextual' scoring signal: seed graph distance from entities
    // the caller flagged (context.recentEntityIds) plus entities named in the
    // query, BFS the KG, and map to frames via the kg_entity_frames bridge.
    // Best-effort: a graph hiccup must never fail the search.
    let scoringContext = context;
    if (!scoringContext.graphDistances) {
      try {
        const kg = new KnowledgeGraph(this.db);
        const seeds = new Set<number>(scoringContext.recentEntityIds ?? []);
        for (const id of kg.findEntitiesInText(query)) seeds.add(id);
        if (seeds.size > 0) {
          const graphDistances = kg.frameDistancesFromEntities([...seeds], 3);
          if (graphDistances.size > 0) scoringContext = { ...scoringContext, graphDistances };
        }
      } catch { /* contextual signal is optional */ }
    }

    const results: SearchResult[] = [];
    for (const [frameId, rrfScore] of rrfScores) {
      const frame = frameMap.get(frameId);
      if (!frame) continue;

      const relevanceScore = computeRelevance(
        {
          id: frame.id,
          // Temporal decay anchors on write time, not access time
          // (forward-ported from waggle-os monorepo, mono-parity 2026-06-12).
          created_at: frame.created_at,
          last_accessed: frame.last_accessed,
          access_count: frame.access_count,
          importance: frame.importance as Importance,
        },
        weights,
        scoringContext,
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
      // FTS5 parse error (e.g. user query with FTS5-special chars that survived
      // sanitization) — fall back to a LIKE keyword scan over the same column so
      // we return best-effort matches instead of a false "no memory found".
      // Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
      return this.likeFallbackSearch(query, limit, gopId);
    }
  }

  /**
   * LIKE-based keyword fallback over memory_frames.content. Used when the FTS5
   * MATCH query throws a parse error (e.g. an unbalanced quote or other FTS5
   * operator the user typed literally). The raw query is split into word tokens
   * — stripping the punctuation that caused the FTS5 error, mirroring the
   * primary sanitizer — and matched with OR-ed LIKE clauses for best-effort
   * recall. Bound parameters only (the term is never interpolated) and LIKE
   * metachars (`%`, `_`, `\`) are escaped with an ESCAPE clause so each token
   * matches literally. If no usable token survives, a single literal LIKE over
   * the whole escaped query is used.
   * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
   */
  private likeFallbackSearch(query: string, limit: number, gopId?: string): number[] {
    const raw = this.db.getDatabase();

    const tokens = query
      .split(/\s+/)
      .map((w) => w.replace(/[^\w]/g, '')) // strip punctuation (incl. FTS5 operators)
      .filter((w) => w.length > 0);
    const terms = (tokens.length > 0 ? tokens : [query]).map((t) => `%${escapeLikeTerm(t)}%`);

    const likeClause = terms.map(() => `content LIKE ? ESCAPE '\\'`).join(' OR ');

    try {
      if (gopId) {
        const rows = raw
          .prepare(
            `SELECT id FROM memory_frames
             WHERE (${likeClause}) AND gop_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...terms, gopId, limit) as { id: number }[];
        return rows.map((r) => r.id);
      }
      const rows = raw
        .prepare(
          `SELECT id FROM memory_frames
           WHERE (${likeClause})
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...terms, limit) as { id: number }[];
      return rows.map((r) => r.id);
    } catch {
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

    // Keep the chunk index in lockstep with live frame writes (previously
    // chunks were only populated via `maintenance --rechunk-all`). Soft-fail
    // — a chunk-indexing error must never break the primary whole-frame
    // write (mirrors the reranker soft-fail stance).
    // Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
    if (chunkRetrievalEnabled()) {
      try {
        await this.indexChunksForFrame(frameId, content);
      } catch (err) {
        log.warn(
          `chunk indexing failed for frame ${id} (whole-frame vector written): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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

    // Chunk-index batch writes too, so frames ingested via the batch path
    // (harvest) aren't invisible to the chunk lane. Soft-fail per frame —
    // see indexFrame.
    // Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
    if (chunkRetrievalEnabled()) {
      for (const f of frames) {
        try {
          await this.indexChunksForFrame(f.id, f.content);
        } catch (err) {
          log.warn(
            `chunk indexing failed for frame ${Math.trunc(f.id)} (whole-frame vector written): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
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
   * Idempotent — safe to call repeatedly. Used by the --rechunk-all migration
   * and by the flag-gated indexFrame path. NOT itself gated on
   * HIVE_MIND_CHUNK_RETRIEVAL (backfill + eval call it directly).
   */
  async indexChunksForFrame(
    frameId: number,
    content: string,
    opts: ChunkOptions = {},
  ): Promise<number> {
    if (!Number.isFinite(frameId) || frameId <= 0) {
      throw new Error('Invalid frame ID for chunk indexing');
    }
    this.ensureFingerprint();
    const raw = this.db.getDatabase();
    const id = Math.trunc(frameId);

    const chunks = chunkText(content, opts);
    if (chunks.length === 0) return 0;

    // Embed all chunks. embedBatch amortises HTTP overhead on Ollama/API providers.
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

// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
export interface RechunkResult {
  framesProcessed: number;
  chunksCreated: number;
  framesFailed: number;
}

/**
 * (Re)chunk + chunk-index every non-deprecated frame in the .mind. Idempotent
 * per-frame — indexChunksForFrame deletes a frame's existing chunks before
 * re-inserting. One bad frame doesn't abort the batch (logged + counted).
 * Library-level backfill/eval helper (the CLI `maintenance --rechunk-all`
 * remains the operator surface) — NOT gated on HIVE_MIND_CHUNK_RETRIEVAL
 * (it must be runnable before any flag flip).
 */
export async function rechunkAllFrames(db: MindDB, search: HybridSearch): Promise<RechunkResult> {
  const raw = db.getDatabase();
  const frames = raw
    .prepare("SELECT id, content FROM memory_frames WHERE importance != 'deprecated' ORDER BY id ASC")
    .all() as Array<{ id: number; content: string }>;

  let framesProcessed = 0;
  let chunksCreated = 0;
  let framesFailed = 0;

  for (const f of frames) {
    try {
      const n = await search.indexChunksForFrame(f.id, f.content);
      framesProcessed++;
      chunksCreated += n;
    } catch (err) {
      framesFailed++;
      log.warn(
        `rechunkAllFrames: frame ${f.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { framesProcessed, chunksCreated, framesFailed };
}

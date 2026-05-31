/**
 * `hive-mind-cli maintenance` — batch maintenance ops for a nightly
 * cron. Composes FrameStore.compact + optional wipe-imports + index
 * reconciliation + KG cognify + wiki compile behind a single flag surface.
 */

import * as fs from 'node:fs';
import { openPersonalMind, type CliEnv } from '../setup.js';
import {
  reconcileIndexes,
  HybridSearch,
  MindDB,
  FrameStore,
  KnowledgeGraph,
  maxEmbedCharsForModel,
  capEmbedText,
  type EmbeddingProviderInstance,
} from '@hive-mind/core';
import { runCognify } from './cognify.js';
import { runCompileWiki } from './compile-wiki.js';

export interface MaintenanceOptions {
  compact?: boolean;
  wipeImports?: boolean;
  reconcile?: boolean;
  /**
   * Purge memory_frames_vec and re-embed every frame. Use after a period
   * of running with provider=mock (vec rows are byte-hash garbage in that
   * state) or after switching to a higher-quality embedder. Idempotent.
   * Costs one embed call per frame (~30-100ms each on local Ollama).
   */
  reembedAll?: boolean;
  /**
   * Re-chunk every frame: paragraph-split content, embed each chunk into
   * memory_frame_chunks_vec. Provides the precision boost that whole-frame
   * embeddings can't deliver on domain-homogeneous corpora. Idempotent —
   * existing chunks for each frame are dropped before re-insertion.
   * Costs one embed call per chunk (~3 chunks/frame avg → ~3x reembed cost).
   */
  rechunkAll?: boolean;
  /**
   * Merge duplicate KG entities that share a normalized name + type: re-point
   * the duplicates' relations onto the survivor, sum seen_count, retire the
   * dups. Idempotent. Replaces the .harvest purge-noise-entities dedup pass.
   */
  dedupeEntities?: boolean;
  cognify?: boolean;
  wiki?: boolean;
  maxTempAgeDays?: number;
  maxDeprecatedAgeDays?: number;
  /**
   * Run maintenance against a workspace mind instead of personal. Mutually
   * exclusive with allWorkspaces. Workspace must already exist.
   */
  workspace?: string;
  /**
   * Iterate every registered workspace mind. Personal is NOT included by
   * default — run a separate invocation for that. Per-workspace failures
   * are logged but don't abort the loop.
   */
  allWorkspaces?: boolean;
  env?: CliEnv;
}

export interface MaintenanceResult {
  compact?: {
    temporaryPruned: number;
    deprecatedPruned: number;
    pframesMerged: number;
  };
  wipeImports?: {
    framesDeleted: number;
  };
  reconcile?: {
    ftsFixed: number;
    vecFixed: number;
  };
  reembedAll?: {
    framesEmbedded: number;
    activeProvider: string;
    modelName: string;
    durationMs: number;
  };
  rechunkAll?: {
    framesProcessed: number;
    chunksCreated: number;
    activeProvider: string;
    modelName: string;
    durationMs: number;
  };
  dedupeEntities?: {
    groups: number;
    merged: number;
  };
  cognify?: {
    framesScanned: number;
    entitiesCreated: number;
    entitiesUpdated: number;
  };
  wiki?: {
    provider: string;
    pagesCreated: number;
    pagesUpdated: number;
    pagesUnchanged: number;
  };
  durationMs: number;
}

/**
 * Re-embed every frame in a mind. Wipes memory_frames_vec then batch-embeds
 * via the supplied provider. Refuses to run with provider=mock — re-embedding
 * with mock would just rewrite the same byte-hash garbage and waste IO.
 *
 * Takes primitives (db + embedder) rather than CliEnv so the same code path
 * serves personal and workspace minds. The CliEnv-shaped wrapper below
 * preserves the original signature.
 */
async function runReembedAllOnMind(db: MindDB, embedder: EmbeddingProviderInstance): Promise<MaintenanceResult['reembedAll']> {
  const start = Date.now();
  const status = embedder.getStatus();

  if (status.activeProvider === 'mock') {
    throw new Error(
      'Refusing to --reembed-all with active provider=mock. ' +
      'Set OLLAMA_URL or another real provider first, then re-run.',
    );
  }

  const raw = db.getDatabase();
  const activeFp = {
    provider: status.activeProvider,
    model: status.modelName,
    dim: embedder.dimensions,
  };
  const frames = raw
    .prepare("SELECT id, content FROM memory_frames WHERE importance != 'deprecated' ORDER BY id ASC")
    .all() as Array<{ id: number; content: string }>;

  if (frames.length === 0) {
    return { framesEmbedded: 0, activeProvider: status.activeProvider, modelName: status.modelName, durationMs: Date.now() - start };
  }

  // If the embedding dimension changed, vec0 columns can't be ALTERed — DROP +
  // CREATE both vec tables at the new dim (the remediation for an
  // EmbeddingDimMismatchError). Otherwise just wipe whole-frame vectors so a
  // partial failure leaves the table empty (next reconcile refills it).
  const stored = db.getEmbeddingFingerprint();
  if (stored && stored.dim !== activeFp.dim) {
    db.recreateVecTables(activeFp.dim);
    process.stderr.write(
      `[reembed-all] embedding dim changed ${stored.dim} → ${activeFp.dim}; recreated vec tables. ` +
        `Run --rechunk-all to rebuild chunk vectors.\n`,
    );
  } else {
    raw.prepare('DELETE FROM memory_frames_vec').run();
  }

  // Batch embed in chunks of 32 — Ollama is fastest with small batches and
  // memory stays bounded. Use embedBatch to amortize HTTP overhead.
  // sqlite-vec quirk: rowid must be a literal SQL integer, not a bound
  // parameter. Inlining the id matches the pattern in core/search.ts.
  //
  // Two robustness measures from the audit:
  //   1. Truncate to MAX_EMBED_CHARS — nomic-embed-text's 8192-token context
  //      blows up on long frames (synthesis bundles, session handoffs). 30K
  //      chars is a safe undershoot of the model limit.
  //   2. Per-frame fallback to single embed when batch fails — without this,
  //      one oversize frame would silently poison all 31 batchmates with
  //      mock embeddings (the embedder catches batch errors and substitutes
  //      mock for the whole batch).
  const BATCH = 32;
  // Auto-detect cap from active model. nomic-embed-text has 2048-token
  // default context (~6K chars dense English). The custom `*-8k` variants
  // (e.g. `nomic-embed-text-8k` = `FROM nomic-embed-text` + `PARAMETER num_ctx 8192`)
  // raise the limit to 8192 tokens (~24K chars). Keep a safe undershoot.
  const modelName = embedder.getStatus().modelName;
  // Shared with the core embedding provider so the cap can never drift.
  const MAX_EMBED_CHARS = maxEmbedCharsForModel(modelName);
  const f32ToBlob = (vec: Float32Array): Buffer => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  const prepText = (s: string): string => capEmbedText(s, MAX_EMBED_CHARS);

  let embedded = 0;
  let truncated = 0;
  for (const f of frames) if (f.content.length > MAX_EMBED_CHARS) truncated++;

  for (let i = 0; i < frames.length; i += BATCH) {
    const slice = frames.slice(i, i + BATCH);
    const texts = slice.map((f) => prepText(f.content));

    let vectors: Float32Array[];
    try {
      // Direct call to the underlying embedder bypasses the noisy batch-
      // wide mock fallback in EmbeddingProviderInstance.embedBatch.
      // We want to see real per-call failures, not silent substitution.
      vectors = await Promise.all(texts.map((t) => embedder.embed(t)));
    } catch (err) {
      // Single-call paths also fall back to mock inside embedder.embed().
      // Treat this as a hard skip and continue — better to leave a frame
      // un-embedded than to insert mock noise. Reconcile can re-try later.
      const msg = err instanceof Error ? err.message : String(err);
      // Use stderr so JSON consumers still see this banner.
      process.stderr.write(`[reembed-all] batch ${i / BATCH} failed entirely: ${msg}\n`);
      continue;
    }

    const tx = raw.transaction(() => {
      for (let j = 0; j < slice.length; j++) {
        const id = slice[j].id;
        if (!Number.isInteger(id) || id <= 0) continue;
        raw
          .prepare(`INSERT INTO memory_frames_vec (rowid, embedding) VALUES (${id}, ?)`)
          .run(f32ToBlob(vectors[j]));
      }
    });
    tx();
    embedded += slice.length;
  }

  if (truncated > 0) {
    process.stderr.write(`[reembed-all] ${truncated} frame(s) > ${MAX_EMBED_CHARS} chars were truncated for embedding\n`);
  }

  // Record the fingerprint of the embedder that produced these vectors so the
  // dim guard matches (and a later model swap is detected) on the next open.
  db.setEmbeddingFingerprint(activeFp);

  return {
    framesEmbedded: embedded,
    activeProvider: status.activeProvider,
    modelName: status.modelName,
    durationMs: Date.now() - start,
  };
}

/**
 * Re-chunk every frame: split content into ~500-token paragraphs, embed
 * each chunk into memory_frame_chunks_vec. Refuses to run with mock
 * provider (would just write byte-hash garbage). Idempotent per-frame —
 * indexChunksForFrame deletes existing chunks before re-inserting.
 *
 * Takes primitives (db + embedder) so the same path runs against personal
 * or workspace minds.
 */
async function runRechunkAllOnMind(db: MindDB, embedder: EmbeddingProviderInstance): Promise<MaintenanceResult['rechunkAll']> {
  const start = Date.now();
  const status = embedder.getStatus();

  if (status.activeProvider === 'mock') {
    throw new Error(
      'Refusing to --rechunk-all with active provider=mock. ' +
      'Set OLLAMA_URL or another real provider first, then re-run.',
    );
  }

  const search = new HybridSearch(db, embedder);
  const raw = db.getDatabase();
  const frames = raw
    .prepare("SELECT id, content FROM memory_frames WHERE importance != 'deprecated' ORDER BY id ASC")
    .all() as Array<{ id: number; content: string }>;

  let framesProcessed = 0;
  let chunksCreated = 0;

  for (const f of frames) {
    try {
      const n = await search.indexChunksForFrame(f.id, f.content);
      framesProcessed++;
      chunksCreated += n;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rechunk-all] frame ${f.id} failed: ${msg}\n`);
      // Continue — one bad frame shouldn't abort the whole batch.
    }
  }

  return {
    framesProcessed,
    chunksCreated,
    activeProvider: status.activeProvider,
    modelName: status.modelName,
    durationMs: Date.now() - start,
  };
}

/**
 * Subset of maintenance ops that operate purely on a MindDB+embedder
 * pair (no CliEnv-specific state). Used by both the personal and
 * workspace dispatch paths so the per-mind body stays in one place.
 *
 * Skipped here (handled at higher level): cognify and wiki — both already
 * have their own --workspace / --all-workspaces flags so we delegate to
 * runCognify({workspace}) / runCompileWiki({workspace}) instead of trying
 * to plumb workspace ids through the maintenance dispatch.
 */
async function runMaintenanceOnMind(
  db: MindDB,
  frames: FrameStore,
  embedder: EmbeddingProviderInstance,
  options: MaintenanceOptions,
  result: MaintenanceResult,
): Promise<void> {
  if (options.compact) {
    const r = frames.compact(
      options.maxTempAgeDays ?? 30,
      options.maxDeprecatedAgeDays ?? 90,
    );
    result.compact = {
      temporaryPruned: r.temporaryPruned,
      deprecatedPruned: r.deprecatedPruned,
      pframesMerged: r.pframesMerged,
    };
  }

  if (options.wipeImports) {
    const raw = db.getDatabase();
    const countRow = raw
      .prepare("SELECT COUNT(*) as cnt FROM memory_frames WHERE source = 'import'")
      .get() as { cnt: number };

    if (countRow.cnt > 0) {
      const frameIds = raw
        .prepare("SELECT id FROM memory_frames WHERE source = 'import'")
        .all() as { id: number }[];

      const tx = raw.transaction(() => {
        for (const { id } of frameIds) {
          raw.prepare('DELETE FROM memory_frames_fts WHERE rowid = ?').run(id);
          try {
            raw.prepare('DELETE FROM memory_frames_vec WHERE rowid = ?').run(id);
          } catch { /* vec optional */ }
        }
        raw.prepare("DELETE FROM memory_frames WHERE source = 'import'").run();
      });
      tx();
    }

    result.wipeImports = { framesDeleted: countRow.cnt };
  }

  if (options.reconcile) {
    const r = await reconcileIndexes(db, embedder);
    result.reconcile = { ftsFixed: r.ftsFixed, vecFixed: r.vecFixed };
  }

  if (options.reembedAll) {
    result.reembedAll = await runReembedAllOnMind(db, embedder);
  }

  if (options.rechunkAll) {
    result.rechunkAll = await runRechunkAllOnMind(db, embedder);
  }

  if (options.dedupeEntities) {
    result.dedupeEntities = new KnowledgeGraph(db).dedupeByName();
  }
}

export async function runMaintenance(options: MaintenanceOptions): Promise<MaintenanceResult> {
  if (options.allWorkspaces) {
    return runMaintenanceAllWorkspaces(options);
  }
  if (options.workspace) {
    return runMaintenanceOnWorkspace(options.workspace, options);
  }
  return runMaintenanceOnPersonal(options);
}

async function runMaintenanceOnPersonal(options: MaintenanceOptions): Promise<MaintenanceResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  const start = Date.now();
  const result: MaintenanceResult = { durationMs: 0 };

  try {
    const embedder = await env.getEmbedder();
    await runMaintenanceOnMind(env.db, env.frames, embedder, options, result);

    if (options.cognify) {
      const r = await runCognify({ env });
      result.cognify = {
        framesScanned: r.framesScanned,
        entitiesCreated: r.entitiesCreated,
        entitiesUpdated: r.entitiesUpdated,
      };
    }

    if (options.wiki) {
      const r = await runCompileWiki({ env });
      result.wiki = {
        provider: r.provider,
        pagesCreated: r.pagesCreated,
        pagesUpdated: r.pagesUpdated,
        pagesUnchanged: r.pagesUnchanged,
      };
    }

    result.durationMs = Date.now() - start;
    return result;
  } finally {
    close();
  }
}

async function runMaintenanceOnWorkspace(workspaceId: string, options: MaintenanceOptions): Promise<MaintenanceResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  const start = Date.now();
  const result: MaintenanceResult = { durationMs: 0 };

  try {
    const wm = env.workspaces;
    const ws = wm.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    const mindPath = wm.getMindPath(workspaceId);
    if (!fs.existsSync(mindPath)) {
      throw new Error(`Workspace mind file missing: ${mindPath}. Save at least one memory to materialise it.`);
    }

    const embedder = await env.getEmbedder();
    const wsDb = new MindDB(mindPath);
    try {
      const wsFrames = new FrameStore(wsDb);
      await runMaintenanceOnMind(wsDb, wsFrames, embedder, options, result);

      if (options.cognify) {
        const r = await runCognify({ workspace: workspaceId, env });
        result.cognify = {
          framesScanned: r.framesScanned,
          entitiesCreated: r.entitiesCreated,
          entitiesUpdated: r.entitiesUpdated,
        };
      }

      if (options.wiki) {
        const r = await runCompileWiki({ workspace: workspaceId, env });
        result.wiki = {
          provider: r.provider,
          pagesCreated: r.pagesCreated,
          pagesUpdated: r.pagesUpdated,
          pagesUnchanged: r.pagesUnchanged,
        };
      }

      result.durationMs = Date.now() - start;
      return result;
    } finally {
      wsDb.close();
    }
  } finally {
    close();
  }
}

async function runMaintenanceAllWorkspaces(options: MaintenanceOptions): Promise<MaintenanceResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  const start = Date.now();
  const aggregate: MaintenanceResult = { durationMs: 0 };

  // Per-mind aggregation. Stuff like reembed-all reports a 'framesEmbedded'
  // count — we sum across workspaces and let the caller see the headline
  // number. cognify/wiki delegate to their existing --all-workspaces paths.
  let totalEmbedded = 0;
  let totalFramesProcessed = 0;
  let totalChunks = 0;
  let totalReconcileFts = 0;
  let totalReconcileVec = 0;

  try {
    const embedder = await env.getEmbedder();
    for (const ws of env.workspaces.list()) {
      const mindPath = env.workspaces.getMindPath(ws.id);
      if (!fs.existsSync(mindPath)) continue;
      try {
        const wsDb = new MindDB(mindPath);
        try {
          const wsFrames = new FrameStore(wsDb);
          const wsResult: MaintenanceResult = { durationMs: 0 };
          await runMaintenanceOnMind(wsDb, wsFrames, embedder, options, wsResult);
          if (wsResult.reembedAll) {
            totalEmbedded += wsResult.reembedAll.framesEmbedded;
            // Take the last seen provider/model — they're identical across
            // minds since we share one embedder instance.
            aggregate.reembedAll = {
              framesEmbedded: totalEmbedded,
              activeProvider: wsResult.reembedAll.activeProvider,
              modelName: wsResult.reembedAll.modelName,
              durationMs: (aggregate.reembedAll?.durationMs ?? 0) + wsResult.reembedAll.durationMs,
            };
          }
          if (wsResult.rechunkAll) {
            totalFramesProcessed += wsResult.rechunkAll.framesProcessed;
            totalChunks += wsResult.rechunkAll.chunksCreated;
            aggregate.rechunkAll = {
              framesProcessed: totalFramesProcessed,
              chunksCreated: totalChunks,
              activeProvider: wsResult.rechunkAll.activeProvider,
              modelName: wsResult.rechunkAll.modelName,
              durationMs: (aggregate.rechunkAll?.durationMs ?? 0) + wsResult.rechunkAll.durationMs,
            };
          }
          if (wsResult.reconcile) {
            totalReconcileFts += wsResult.reconcile.ftsFixed;
            totalReconcileVec += wsResult.reconcile.vecFixed;
            aggregate.reconcile = { ftsFixed: totalReconcileFts, vecFixed: totalReconcileVec };
          }
        } finally {
          wsDb.close();
        }
      } catch (err) {
        // One bad workspace shouldn't abort the loop. Surface and continue.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[maintenance] workspace ${ws.id} failed: ${msg}\n`);
      }
    }

    // cognify and wiki already understand --all-workspaces, so when the
    // caller asks for them we delegate one level deeper.
    if (options.cognify) {
      const r = await runCognify({ allWorkspaces: true, env });
      aggregate.cognify = {
        framesScanned: r.framesScanned,
        entitiesCreated: r.entitiesCreated,
        entitiesUpdated: r.entitiesUpdated,
      };
    }
    if (options.wiki) {
      const r = await runCompileWiki({ allWorkspaces: true, env });
      aggregate.wiki = {
        provider: r.provider,
        pagesCreated: r.pagesCreated,
        pagesUpdated: r.pagesUpdated,
        pagesUnchanged: r.pagesUnchanged,
      };
    }

    aggregate.durationMs = Date.now() - start;
    return aggregate;
  } finally {
    close();
  }
}

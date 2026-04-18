/**
 * `hive-mind-cli maintenance` — batch maintenance ops for a nightly
 * cron. Composes FrameStore.compact + optional wipe-imports + index
 * reconciliation + KG cognify + wiki compile behind a single flag surface.
 */

import { openPersonalMind, type CliEnv } from '../setup.js';
import { reconcileIndexes } from '@hive-mind/core';
import { runCognify } from './cognify.js';
import { runCompileWiki } from './compile-wiki.js';

export interface MaintenanceOptions {
  compact?: boolean;
  wipeImports?: boolean;
  reconcile?: boolean;
  cognify?: boolean;
  wiki?: boolean;
  maxTempAgeDays?: number;
  maxDeprecatedAgeDays?: number;
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

export async function runMaintenance(options: MaintenanceOptions): Promise<MaintenanceResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  const start = Date.now();
  const result: MaintenanceResult = { durationMs: 0 };

  try {
    if (options.compact) {
      const r = env.frames.compact(
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
      const raw = env.db.getDatabase();
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
      const embedder = await env.getEmbedder();
      const r = await reconcileIndexes(env.db, embedder);
      result.reconcile = { ftsFixed: r.ftsFixed, vecFixed: r.vecFixed };
    }

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

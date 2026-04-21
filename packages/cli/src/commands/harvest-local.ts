/**
 * `hive-mind-cli harvest-local` — run one of the built-in harvest
 * adapters against a local file or directory. Unlike the MCP
 * harvest_import tool (which takes JSON inline), this variant always
 * reads from disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ChatGPTAdapter,
  ClaudeAdapter,
  ClaudeCodeAdapter,
  GeminiAdapter,
  UniversalAdapter,
  type UniversalImportItem,
} from '@hive-mind/core';
import { openPersonalMind, type CliEnv } from '../setup.js';

/** Narrower ISO-8601 validator than `Date.parse` alone — we require the
 *  `T` separator and a timezone suffix so downstream range queries on
 *  `created_at` aren't corrupted by "mostly ISO" shapes ("2024-03-01",
 *  "2024/03/01 11:00:00") that Date.parse will happily accept. */
function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

export type HarvestSource = 'chatgpt' | 'claude' | 'claude-code' | 'gemini' | 'universal';

export interface HarvestLocalOptions {
  source: HarvestSource;
  path: string;
  env?: CliEnv;
}

export interface HarvestLocalResult {
  source: HarvestSource;
  path: string;
  itemsFound: number;
  framesCreated: number;
  duplicatesSkipped: number;
  errors: string[];
}

function parseWithAdapter(source: HarvestSource, pathOrJson: string): UniversalImportItem[] {
  const errors: string[] = [];

  // claude-code is filesystem-based; every other adapter parses JSON text.
  if (source === 'claude-code') {
    const adapter = new ClaudeCodeAdapter();
    return adapter.scan(pathOrJson);
  }

  let raw: string;
  try {
    const stat = fs.statSync(pathOrJson);
    if (stat.isDirectory()) {
      errors.push(`Path is a directory — ${source} expects a JSON export file`);
      throw new Error(errors[0]);
    }
    raw = fs.readFileSync(pathOrJson, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read ${pathOrJson}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${pathOrJson} as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  switch (source) {
    case 'chatgpt': return new ChatGPTAdapter().parse(parsed);
    case 'claude': return new ClaudeAdapter().parse(parsed);
    case 'gemini': return new GeminiAdapter().parse(parsed);
    case 'universal': return new UniversalAdapter().parse(parsed);
  }
}

export async function runHarvestLocal(options: HarvestLocalOptions): Promise<HarvestLocalResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;
  const errors: string[] = [];

  try {
    const resolved = path.resolve(options.path);
    if (!fs.existsSync(resolved)) {
      return {
        source: options.source,
        path: resolved,
        itemsFound: 0,
        framesCreated: 0,
        duplicatesSkipped: 0,
        errors: [`Path not found: ${resolved}`],
      };
    }

    let items: UniversalImportItem[];
    try {
      items = parseWithAdapter(options.source, resolved);
    } catch (err) {
      return {
        source: options.source,
        path: resolved,
        itemsFound: 0,
        framesCreated: 0,
        duplicatesSkipped: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }

    if (items.length === 0) {
      return {
        source: options.source,
        path: resolved,
        itemsFound: 0,
        framesCreated: 0,
        duplicatesSkipped: 0,
        errors: [`No items parsed from ${options.source} source`],
      };
    }

    const session = env.sessions.ensure(
      `harvest:${options.source}`,
      undefined,
      `Harvest import from ${options.source} (${path.basename(resolved)})`,
    );

    // Record max frame id before the batch — FrameStore.createIFrame dedups by
    // content, so a "not new" frame returns an older id. id-based detection is
    // format-agnostic; comparing timestamps here would trip on the mismatch
    // between JS's ISO format and SQLite's space-separated datetime('now').
    const raw = env.db.getDatabase();
    const maxBefore =
      (raw.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM memory_frames').get() as { m: number }).m;

    let framesCreated = 0;
    let duplicatesSkipped = 0;
    let timestampFallbacks = 0;

    for (const item of items) {
      const preview = item.content.slice(0, 2000);
      const content = item.title
        ? `[${item.source}] ${item.title}: ${preview}`
        : `[${item.source}] ${preview}`;

      // Preserve the original source timestamp (e.g. Claude `create_time`,
      // ChatGPT `created_at`) on the resulting frame so downstream
      // date-scoped retrieval has a valid temporal anchor. Every adapter
      // already surfaces `item.timestamp` on the UniversalImportItem;
      // prior to this fix the harvest path discarded it and
      // `memory_frames.created_at` defaulted to ingest wall-clock, which
      // made questions like "what happened in December 2025" unanswerable
      // against frames harvested in April 2026.
      //
      // Fallback is explicit, never silent:
      //   - valid ISO-8601 string → passed through to createIFrame
      //   - null / undefined / malformed → fallback to NOW() via schema
      //     default + console.warn that names the adapter source and
      //     item id so Wave-3D adapter reviews can trace the gap.
      const providedTimestamp = typeof item.timestamp === 'string' ? item.timestamp : undefined;
      const useProvidedTs = providedTimestamp !== undefined && isIsoTimestamp(providedTimestamp);
      if (!useProvidedTs) {
        timestampFallbacks++;
        console.warn(
          `[harvest-local] missing timestamp — falling back to NOW() for item ` +
          `source=${item.source} id=${item.id}${providedTimestamp !== undefined ? ` (invalid input: "${providedTimestamp}")` : ''}`,
        );
      }

      const frame = env.frames.createIFrame(
        session.gop_id,
        content,
        'normal',
        'import',
        useProvidedTs ? providedTimestamp : null,
      );
      if (frame.id > maxBefore) framesCreated++;
      else duplicatesSkipped++;
    }
    if (timestampFallbacks > 0) {
      errors.push(
        `timestamp fallback applied to ${timestampFallbacks} item(s); see warn logs for details`,
      );
    }

    // Track in the harvest source store for later "harvest_sources" listing.
    try {
      env.harvestSources.upsert(
        options.source as Parameters<typeof env.harvestSources.upsert>[0],
        options.source,
        resolved,
      );
      env.harvestSources.recordSync(
        options.source as Parameters<typeof env.harvestSources.recordSync>[0],
        items.length,
        framesCreated,
      );
    } catch (err) {
      errors.push(`harvest source tracking failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      source: options.source,
      path: resolved,
      itemsFound: items.length,
      framesCreated,
      duplicatesSkipped,
      errors,
    };
  } finally {
    close();
  }
}

/**
 * `hive-mind-cli status` — show frame/entity/relation counts and the most
 * recent frame, so a persona can eyeball whether the memory substrate is
 * healthy without opening the SQLite file directly.
 *
 * Read-only: does not probe the embedder, does not mutate anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openPersonalMind, resolveDataDir, type CliEnv } from '../setup.js';

export interface StatusOptions {
  env?: CliEnv;
  dataDir?: string;
}

export interface StatusResult {
  dataDir: string;
  personalMindExists: boolean;
  frames: number;
  entities: number;
  relations: number;
  entityTypeCounts: Array<{ type: string; count: number }>;
  lastFrame: {
    id: number;
    source: string;
    importance: string;
    created_at: string;
    preview: string;
  } | null;
  workspaces: Array<{ id: string; name: string }>;
}

/** Content preview cap — long frames don't flood the status output. */
const PREVIEW_CHARS = 80;

export async function runStatus(options: StatusOptions = {}): Promise<StatusResult> {
  const dataDir = options.env?.dataDir ?? options.dataDir ?? resolveDataDir();
  const personalMindPath = path.join(dataDir, 'personal.mind');
  const personalMindExists = fs.existsSync(personalMindPath);

  if (!personalMindExists && !options.env) {
    return {
      dataDir,
      personalMindExists: false,
      frames: 0,
      entities: 0,
      relations: 0,
      entityTypeCounts: [],
      lastFrame: null,
      workspaces: [],
    };
  }

  const env = options.env ?? openPersonalMind(dataDir);
  const close = options.env ? () => { /* caller owns */ } : env.close;

  try {
    const db = env.db.getDatabase();

    // memory_frames uses importance='deprecated' as a tombstone (no valid_to column).
    const frameCountRow = db
      .prepare("SELECT COUNT(*) AS n FROM memory_frames WHERE importance != 'deprecated'")
      .get() as { n: number } | undefined;
    const relationCountRow = db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_relations WHERE valid_to IS NULL")
      .get() as { n: number } | undefined;

    const lastFrameRow = db
      .prepare(
        "SELECT id, source, importance, created_at, content FROM memory_frames " +
        "WHERE importance != 'deprecated' ORDER BY id DESC LIMIT 1",
      )
      .get() as {
        id: number;
        source: string;
        importance: string;
        created_at: string;
        content: string;
      } | undefined;

    const entityCount = env.kg.getEntityCount();
    const entityTypeCounts = env.kg.getEntityTypeCounts();

    const workspaceList = env.workspaces.list().map((w) => ({
      id: w.id,
      name: w.name,
    }));

    return {
      dataDir: env.dataDir,
      personalMindExists: true,
      frames: frameCountRow?.n ?? 0,
      entities: entityCount,
      relations: relationCountRow?.n ?? 0,
      entityTypeCounts,
      lastFrame: lastFrameRow ? {
        id: lastFrameRow.id,
        source: lastFrameRow.source,
        importance: lastFrameRow.importance,
        created_at: lastFrameRow.created_at,
        preview: previewOf(lastFrameRow.content),
      } : null,
      workspaces: workspaceList,
    };
  } finally {
    close();
  }
}

function previewOf(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized.length <= PREVIEW_CHARS
    ? normalized
    : normalized.slice(0, PREVIEW_CHARS - 1) + '…';
}

export function renderStatusResult(result: StatusResult, format: 'plain' | 'json' = 'plain'): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [];
  lines.push('hive-mind status');
  lines.push(`  data dir:     ${result.dataDir}`);

  if (!result.personalMindExists) {
    lines.push('  personal:     not initialised — run `hive-mind-cli init`');
    return lines.join('\n');
  }

  lines.push(`  frames:       ${result.frames.toLocaleString('en-US')}`);
  lines.push(`  entities:     ${result.entities.toLocaleString('en-US')}`);
  lines.push(`  relations:    ${result.relations.toLocaleString('en-US')}`);

  if (result.entityTypeCounts.length > 0) {
    const top = result.entityTypeCounts.slice(0, 5)
      .map((e) => `${e.type}=${e.count}`)
      .join(' ');
    lines.push(`  top types:    ${top}`);
  }

  if (result.lastFrame) {
    const when = result.lastFrame.created_at.replace('T', ' ').slice(0, 16);
    lines.push(
      `  last frame:   #${result.lastFrame.id} (${result.lastFrame.source}, ` +
      `${result.lastFrame.importance}, ${when})`,
    );
    lines.push(`                "${result.lastFrame.preview}"`);
  } else {
    lines.push('  last frame:   (none — try `hive-mind-cli save-session`)');
  }

  if (result.workspaces.length > 0) {
    lines.push(`  workspaces:   ${result.workspaces.length} ` +
      `(${result.workspaces.slice(0, 3).map((w) => w.name).join(', ')}` +
      `${result.workspaces.length > 3 ? ', …' : ''})`);
  }

  return lines.join('\n');
}

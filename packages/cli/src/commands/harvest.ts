/**
 * `hive-mind harvest [--root <dir>] [--dry]` — walk a project tree for
 * HIGH-SIGNAL `.mind/` files (STATE.md / DECISIONS.md / PROGRESS.md) and save
 * each as a memory frame.
 *
 * Ported from `.harvest/harvest-mind-v2.cjs`. Changes on lift:
 *   - Root is configurable (`--root`, else `HIVE_MIND_HARVEST_ROOT`, else cwd)
 *     instead of a hardcoded `D:/Projects`.
 *   - Saves directly via FrameStore instead of spawning `cli mcp call save_memory`.
 *   - No SHA state file: FrameStore dedups by content_hash (see frames.ts), so
 *     re-harvesting an unchanged file is a transparent no-op.
 * The frame header format is preserved verbatim for the .harvest equivalence gate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openPersonalMind, type CliEnv } from '../setup.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'hive-mind-test', '.harvest']);
const HIGH_SIGNAL = new Set(['STATE.md', 'DECISIONS.md', 'PROGRESS.md']);
const MAX_BYTES = 30 * 1024;
const CHUNK_BYTES = 25 * 1024;
const MAX_DEPTH = 5;

/** Walk `rootDir` (depth-capped, skipping SKIP_DIRS) and collect top-level
 *  HIGH_SIGNAL files inside any `.mind/` directory. Checkpoints/ subdirs of
 *  `.mind/` are intentionally skipped (only the top-level files). */
export function findHighSignalFiles(rootDir: string): string[] {
  const out: string[] = [];

  const collectFromMind = (mindDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(mindDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && HIGH_SIGNAL.has(e.name)) out.push(path.join(mindDir, e.name));
    }
  };

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.mind') continue;
      if (SKIP_DIRS.has(e.name)) continue;
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === '.mind') collectFromMind(full);
      else walk(full, depth + 1);
    }
  };

  walk(rootDir, 0);
  return out;
}

/** Split content into ≤25KB slices only when it exceeds the 30KB embed-safe cap. */
export function chunkContent(content: string): string[] {
  if (Buffer.byteLength(content, 'utf8') <= MAX_BYTES) return [content];
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += CHUNK_BYTES) {
    chunks.push(content.slice(i, i + CHUNK_BYTES));
  }
  return chunks;
}

/** Provenance header prepended to each harvested frame. Verbatim from .harvest. */
export function harvestHeader(proj: string, filename: string, idx: number, total: number): string {
  return total > 1
    ? `[harvest .mind project:${proj} file:${filename} chunk:${idx + 1}/${total}]\n\n`
    : `[harvest .mind project:${proj} file:${filename}]\n\n`;
}

function projectOf(root: string, filePath: string): string {
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  return rel.split('/')[0] || '.';
}

export interface HarvestOptions {
  root?: string;
  dry?: boolean;
  env?: CliEnv;
}

export interface HarvestResult {
  root: string;
  filesFound: number;
  filesProcessed: number;
  framesWritten: number;
  filesFailed: number;
  projects: string[];
  dryRun: boolean;
}

export async function runHarvest(options: HarvestOptions = {}): Promise<HarvestResult> {
  const root = options.root ?? process.env.HIVE_MIND_HARVEST_ROOT ?? process.cwd();
  const dry = options.dry ?? false;
  const env = options.env ?? openPersonalMind();
  const close = options.env ? (): void => {} : env.close;

  try {
    const files = findHighSignalFiles(root);
    const projects = new Set<string>();
    let filesProcessed = 0;
    let framesWritten = 0;
    let filesFailed = 0;

    const session = dry
      ? null
      : env.sessions.ensure('harvest', undefined, 'Tree harvest of high-signal .mind files');

    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        filesFailed++;
        continue;
      }
      if (!content.trim()) continue;
      filesProcessed++;
      const proj = projectOf(root, file);
      projects.add(proj);
      const filename = path.basename(file);
      const chunks = chunkContent(content);

      if (dry) {
        framesWritten += chunks.length;
        continue;
      }
      chunks.forEach((chunk, idx) => {
        env.frames.createIFrame(
          session!.gop_id,
          harvestHeader(proj, filename, idx, chunks.length) + chunk,
          'normal',
          'system',
        );
        framesWritten++;
      });
    }

    return {
      root,
      filesFound: files.length,
      filesProcessed,
      framesWritten,
      filesFailed,
      projects: [...projects].sort(),
      dryRun: dry,
    };
  } finally {
    close();
  }
}

/**
 * `hive-mind digest [--week <YYYY-Www>] [--dry-run]` — summarise the last 7
 * days of activity across the personal + workspace minds into a markdown digest
 * via `claude -p` (no API key — uses the CC subscription).
 *
 * Ported from `.harvest/weekly-digest.cjs`. Lift changes:
 *   - Reads minds through the CLI env (personal + workspaces) instead of raw
 *     better-sqlite3 on hardcoded file paths.
 *   - Output dir is env-driven (`HIVE_MIND_DIGEST_DIR`, else `<dataDir>/digests`)
 *     instead of a hardcoded `D:/Projects/digests`.
 *   - `buildDigestPrompt` is preserved VERBATIM (byte-for-byte) for the .harvest
 *     equivalence gate; `--dry-run` emits exactly that prompt.
 *   - `isoYearWeek` uses UTC components (deterministic + TZ-independent). It is
 *     only used when `--week` is omitted, so it never affects a gated prompt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { openPersonalMind, resolveDataDir, type CliEnv } from '../setup.js';
import type { MindDB } from '@hive-mind/core';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PER_FRAME_CHARS = 500;
const PER_BUCKET_FRAMES = 12;
const PER_BUCKET_PAGES = 10;

export interface ActivityFrame {
  id: number;
  content: string;
  importance: string;
  created_at: string;
}
export interface ActivityPage {
  slug: string;
  name: string;
  page_type: string;
  source_count: number;
  compiled_at: string;
}
export interface ActivityBucket {
  mind: string;
  frames: ActivityFrame[];
  pages: ActivityPage[];
}

/** Thursday-anchored ISO week (YYYY-Www), UTC-based. */
export function isoYearWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Trim per-frame content for prompt budget. */
export function trimContent(s: string): string {
  const c = String(s || '').trim();
  return c.length > PER_FRAME_CHARS ? c.slice(0, PER_FRAME_CHARS) + '…' : c;
}

/**
 * Build the `claude -p` prompt. PRESERVED VERBATIM from weekly-digest.cjs so the
 * .harvest equivalence gate (dry-run byte-diff) stays clean — do not reword.
 */
export function buildDigestPrompt(
  week: string,
  sinceISO: string,
  untilISO: string,
  buckets: ActivityBucket[],
): string {
  const lines: string[] = [];
  lines.push(`You are summarising one developer's week of work into a tight markdown digest.`);
  lines.push(``);
  lines.push(`WEEK: ${week} (frames + wiki pages from ${sinceISO} → ${untilISO})`);
  lines.push(``);
  lines.push(`OUTPUT FORMAT (markdown — emit nothing else, no preamble):`);
  lines.push(``);
  lines.push(`# Week ${week}`);
  lines.push(``);
  lines.push(`## What shipped`);
  lines.push(`- bullet 1 (concrete, verb-first, ≤120 chars)`);
  lines.push(`- bullet 2`);
  lines.push(`- ... (3-6 bullets total)`);
  lines.push(``);
  lines.push(`## What shifted`);
  lines.push(`- bullet on a decision, refactor, or direction change (1-3 bullets)`);
  lines.push(``);
  lines.push(`## What surfaced`);
  lines.push(`- bullet on a bug, gotcha, or thing-to-watch (1-3 bullets)`);
  lines.push(``);
  lines.push(`## Open threads`);
  lines.push(`- bullet on something started-not-finished or flagged-for-later (0-3 bullets)`);
  lines.push(``);
  lines.push(`RULES:`);
  lines.push(`- No fluff. Each bullet must reference a real frame/page or be skipped.`);
  lines.push(`- Use entity names as they appear (filenames, project ids, person names).`);
  lines.push(`- Don't invent activity — if a section has no real signal, write "none this week" and move on.`);
  lines.push(`- Don't paraphrase wiki page names; cite them with backticks if they're the source.`);
  lines.push(``);
  lines.push(`SOURCE DATA:`);
  lines.push(``);

  for (const b of buckets) {
    if (b.frames.length === 0 && b.pages.length === 0) continue;
    lines.push(`### Mind: ${b.mind}`);
    if (b.frames.length > 0) {
      lines.push(`Recent frames (${Math.min(b.frames.length, PER_BUCKET_FRAMES)} of ${b.frames.length}):`);
      for (const f of b.frames.slice(0, PER_BUCKET_FRAMES)) {
        lines.push(`- (${f.importance}) ${f.created_at}: ${trimContent(f.content)}`);
      }
    }
    if (b.pages.length > 0) {
      lines.push(`Recent wiki pages (${Math.min(b.pages.length, PER_BUCKET_PAGES)} of ${b.pages.length}):`);
      for (const p of b.pages.slice(0, PER_BUCKET_PAGES)) {
        lines.push(`- ${p.page_type} \`${p.slug}\` "${p.name}" (${p.source_count} sources, compiled ${p.compiled_at})`);
      }
    }
    lines.push(``);
  }
  lines.push(`Now emit the digest in the exact format above.`);
  return lines.join('\n');
}

/** Read last-7-days frames + recently-compiled wiki pages from one mind. */
function readActivity(db: MindDB, sinceISO: string): { frames: ActivityFrame[]; pages: ActivityPage[] } {
  const raw = db.getDatabase();
  let frames: ActivityFrame[] = [];
  let pages: ActivityPage[] = [];
  try {
    frames = raw
      .prepare(
        `SELECT id, content, importance, created_at FROM memory_frames
         WHERE created_at >= ? AND importance != 'temporary' AND importance != 'deprecated'
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all(sinceISO) as ActivityFrame[];
  } catch {
    /* table may be missing */
  }
  try {
    pages = raw
      .prepare(
        `SELECT slug, name, page_type, source_count, compiled_at FROM wiki_pages
         WHERE compiled_at >= ? AND page_type IN ('entity', 'synthesis', 'concept')
         ORDER BY compiled_at DESC LIMIT 50`,
      )
      .all(sinceISO) as ActivityPage[];
  } catch {
    /* wiki_pages may not exist on a workspace mind that was never compiled */
  }
  return { frames, pages };
}

function collectAllActivity(env: CliEnv, sinceISO: string): ActivityBucket[] {
  const out: ActivityBucket[] = [{ mind: 'personal', ...readActivity(env.db, sinceISO) }];
  for (const ws of env.workspaces.list().sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      const wsDb = env.mindCache.getOrOpen(ws.id);
      if (wsDb) out.push({ mind: ws.id, ...readActivity(wsDb, sinceISO) });
    } catch {
      /* workspace mind missing/locked — skip */
    }
  }
  return out;
}

function callClaudeP(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--output-format=text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      // HIVE_MIND_NO_SYNTH=1 keeps the spawned CC's hooks quiet (no recursive
      // cognify/synth-drain while the digest generates). Same convention as
      // synth-drain + llm-extractor.
      env: { ...process.env, HIVE_MIND_NO_SYNTH: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    proc.on('error', (err) => reject(new Error(`spawn claude failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 400)}`));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export interface DigestOptions {
  week?: string;
  dryRun?: boolean;
  env?: CliEnv;
}

export interface DigestResult {
  week: string;
  totalFrames: number;
  totalPages: number;
  /** populated only in --dry-run */
  prompt?: string;
  /** populated on a real run that wrote a file */
  outPath?: string;
  digested: boolean;
  reason?: string;
}

export async function runDigest(options: DigestOptions = {}): Promise<DigestResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? (): void => {} : env.close;

  try {
    const now = new Date();
    const since = new Date(now.getTime() - SEVEN_DAYS_MS);
    const week = options.week || isoYearWeek(now);
    const sinceISO = since.toISOString().slice(0, 19).replace('T', ' ');
    const untilISO = now.toISOString().slice(0, 19).replace('T', ' ');

    const buckets = collectAllActivity(env, sinceISO);
    const totalFrames = buckets.reduce((s, b) => s + b.frames.length, 0);
    const totalPages = buckets.reduce((s, b) => s + b.pages.length, 0);

    if (totalFrames === 0 && totalPages === 0) {
      return { week, totalFrames, totalPages, digested: false, reason: 'no activity in the last 7 days' };
    }

    const prompt = buildDigestPrompt(week, sinceISO, untilISO, buckets);
    if (options.dryRun) {
      return { week, totalFrames, totalPages, prompt, digested: false, reason: 'dry-run' };
    }

    const digest = await callClaudeP(prompt);
    const digestDir = process.env.HIVE_MIND_DIGEST_DIR ?? path.join(resolveDataDir(), 'digests');
    if (!fs.existsSync(digestDir)) fs.mkdirSync(digestDir, { recursive: true });
    const outPath = path.join(digestDir, `${week}.md`);
    const finalContent = `${digest}\n\n---\n_Generated ${untilISO} by hive-mind digest · ${totalFrames} frames + ${totalPages} pages from last 7 days_\n`;
    fs.writeFileSync(outPath, finalContent, 'utf8');

    return { week, totalFrames, totalPages, outPath, digested: true };
  } finally {
    close();
  }
}

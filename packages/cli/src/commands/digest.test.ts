/**
 * Equivalence golden-diff gate for `hive-mind digest`.
 *
 * This file is the deletion gate for `D:/Projects/.harvest/weekly-digest.cjs`.
 * The gated surface is the trio of VERBATIM-ported pure functions —
 * `buildDigestPrompt`, `trimContent`, `isoYearWeek` — plus the externally
 * observable behavior of `runDigest` (SQL filtering/ordering/limits,
 * empty-activity short-circuit, dry-run side-effect-freeness, multi-mind
 * ordering, and the real-run footer/attribution template).
 *
 * Determinism: every prompt-builder assertion passes week / sinceISO /
 * untilISO LITERALLY, so there is ZERO now() dependency in the gated
 * artifact. The `runDigest` integration tests seed a hermetic temp MindDB
 * (os.tmpdir + mkdtemp), set HIVE_MIND_NO_RERANK=1, never hit a network /
 * embedding provider, never touch ~/.hive-mind or D:/Projects, pass
 * `--week` so the WEEK line is fixed, and mock `node:child_process.spawn`
 * so no real `claude -p` is ever invoked.
 *
 * Each documentedDelta from the equivalence contract is asserted explicitly
 * so the intended divergences are locked in as intentional-and-tested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// ── spawn mock (must be hoisted before importing digest.ts) ────────────
// runDigest -> callClaudeP -> spawn('claude', ...). We replace spawn with
// a fake child process that emits a fixed stdout and exits 0, so a real
// `claude -p` is NEVER executed in the test. The mock also records the
// args/env/stdin it was handed so the spawn-contract invariant is checked.
const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown>; stdin: string }> = [];
let mockExitCode = 0;
let mockStdout = 'MOCK DIGEST BODY';
let mockStderr = '';

vi.mock('node:child_process', () => {
  return {
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: (s: string) => void; end: () => void };
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      let captured = '';
      proc.stdin = {
        write: (s: string) => {
          captured += s;
        },
        end: () => {
          // Fire the data + close on the next tick so the consumer's
          // listeners are already attached (matches real spawn timing).
          setImmediate(() => {
            spawnCalls.push({ cmd, args, opts, stdin: captured });
            if (mockExitCode === 0) {
              if (mockStdout) proc.stdout.emit('data', Buffer.from(mockStdout, 'utf8'));
            } else if (mockStderr) {
              proc.stderr.emit('data', Buffer.from(mockStderr, 'utf8'));
            }
            proc.emit('close', mockExitCode);
          });
        },
      };
      return proc;
    },
  };
});

import {
  isoYearWeek,
  trimContent,
  buildDigestPrompt,
  runDigest,
  type ActivityBucket,
} from './digest.js';
import { openPersonalMind, type CliEnv } from '../setup.js';

// ── helpers ────────────────────────────────────────────────────────────

type RawDb = ReturnType<CliEnv['db']['getDatabase']>;

// memory_frames.gop_id is a NOT NULL TEXT column with a FOREIGN KEY to
// sessions(gop_id), and MindDB enables PRAGMA foreign_keys=ON. So a frame
// needs a matching sessions row first. The digest frame query never groups
// by GOP — it only filters by created_at / importance — so one fixed
// session per DB suffices. ensureSession is idempotent (INSERT OR IGNORE on
// the UNIQUE gop_id).
const TEST_GOP_ID = 'test-gop';

function ensureSession(db: RawDb): void {
  db.prepare(`INSERT OR IGNORE INTO sessions (gop_id) VALUES (?)`).run(TEST_GOP_ID);
}

function insertFrame(
  db: RawDb,
  content: string,
  importance: string,
  createdAt: string,
): void {
  ensureSession(db);
  db.prepare(
    `INSERT INTO memory_frames (frame_type, gop_id, t, content, importance, created_at) VALUES ('I', ?, 0, ?, ?, ?)`,
  ).run(TEST_GOP_ID, content, importance, createdAt);
}

// The core MindDB schema does NOT create wiki_pages — that table is owned by
// the wiki-compiler (packages/wiki-compiler/src/state.ts). We create it here
// with that EXACT canonical shape so a hermetic mind can carry wiki pages.
// A mind that never calls this stays in the "no wiki_pages table" state —
// exactly what the resilience test relies on.
function ensureWikiPages(db: RawDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      slug TEXT PRIMARY KEY,
      page_type TEXT NOT NULL,
      name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      markdown TEXT NOT NULL DEFAULT '',
      frame_ids TEXT NOT NULL DEFAULT '[]',
      compiled_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_count INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function insertPage(
  db: RawDb,
  slug: string,
  name: string,
  pageType: string,
  sourceCount: number,
  compiledAt: string,
): void {
  ensureWikiPages(db);
  db.prepare(
    `INSERT INTO wiki_pages (slug, page_type, name, content_hash, source_count, compiled_at)
     VALUES (?, ?, ?, 'deadbeef', ?, ?)`,
  ).run(slug, pageType, name, sourceCount, compiledAt);
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 1 — pure-function equivalence (no clock, no DB, no network)
// ════════════════════════════════════════════════════════════════════════

describe('digest helpers (original suite — kept)', () => {
  it('isoYearWeek returns Thursday-anchored ISO YYYY-Www', () => {
    expect(isoYearWeek(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01'); // Thu → W01
    expect(isoYearWeek(new Date('2026-01-05T12:00:00Z'))).toBe('2026-W02'); // following Mon
    expect(isoYearWeek(new Date('2025-12-31T12:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('trimContent caps long content with an ellipsis, leaves short content alone', () => {
    expect(trimContent('  short body  ')).toBe('short body');
    const long = 'x'.repeat(600);
    const out = trimContent(long);
    expect(out.length).toBe(501); // 500 + '…'
    expect(out.endsWith('…')).toBe(true);
  });

  it('buildDigestPrompt renders the canonical prompt (equivalence-gated)', () => {
    const buckets: ActivityBucket[] = [
      {
        mind: 'personal',
        frames: [{ id: 1, content: 'shipped the dedupe', importance: 'important', created_at: '2026-05-30 10:00:00' }],
        pages: [{ slug: 'neo4j', name: 'Neo4j', page_type: 'entity', source_count: 30, compiled_at: '2026-05-30 11:00:00' }],
      },
      { mind: 'empty-ws', frames: [], pages: [] }, // skipped (no signal)
    ];
    const prompt = buildDigestPrompt('2026-W22', '2026-05-24 08:00:00', '2026-05-31 08:00:00', buckets);

    expect(prompt.startsWith('You are summarising one developer')).toBe(true);
    expect(prompt).toContain('WEEK: 2026-W22 (frames + wiki pages from 2026-05-24 08:00:00 → 2026-05-31 08:00:00)');
    expect(prompt).toContain('### Mind: personal');
    expect(prompt).toContain('- (important) 2026-05-30 10:00:00: shipped the dedupe');
    expect(prompt).toContain('- entity `neo4j` "Neo4j" (30 sources, compiled 2026-05-30 11:00:00)');
    expect(prompt).not.toContain('### Mind: empty-ws'); // zero-signal minds omitted
    expect(prompt.endsWith('Now emit the digest in the exact format above.')).toBe(true);
  });
});

describe('trimContent — boundary equivalence (coverageGap fill)', () => {
  it('empty / null / undefined → "" (String(s||"").trim())', () => {
    expect(trimContent('')).toBe('');
    // exercise the `|| ''` fallback for non-string inputs
    expect(trimContent(undefined as unknown as string)).toBe('');
    expect(trimContent(null as unknown as string)).toBe('');
    expect(trimContent('   ')).toBe(''); // whitespace-only trims to empty
  });

  it('exactly 500 chars → unchanged, no ellipsis (length 500)', () => {
    const exactly500 = 'a'.repeat(500);
    const out = trimContent(exactly500);
    expect(out).toBe(exactly500);
    expect(out.length).toBe(500);
    expect(out.endsWith('…')).toBe(false);
  });

  it('501 chars → sliced to 500 + "…" (length 501, UTF-8 ellipsis preserved)', () => {
    const len501 = 'b'.repeat(501);
    const out = trimContent(len501);
    expect(out.length).toBe(501);
    expect(out.slice(0, 500)).toBe('b'.repeat(500));
    expect(out.endsWith('…')).toBe(true);
    // Lock the ellipsis as the single 3-byte UTF-8 char U+2026 (not "...").
    expect(out.charCodeAt(500)).toBe(0x2026);
  });
});

describe('isoYearWeek — UTC equivalence + documentedDelta lock', () => {
  // The .ts uses getUTCFullYear/Month/Date; the .cjs used getFullYear/
  // getMonth/getDate (LOCAL components) wrapped in Date.UTC. They yield the
  // same string for the same UTC calendar day. isoYearWeek is ONLY reached
  // when --week is omitted, so it never feeds a --week-pinned gated prompt.
  it('Thursday-anchored ISO week across year boundaries (UTC)', () => {
    expect(isoYearWeek(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01'); // Thu
    expect(isoYearWeek(new Date('2026-01-04T12:00:00Z'))).toBe('2026-W01'); // Sun, same ISO week
    expect(isoYearWeek(new Date('2026-01-05T12:00:00Z'))).toBe('2026-W02'); // Mon, next week
    // 2024-12-30 (Mon) belongs to ISO week 2025-W01 (Thursday anchor lands in 2025).
    expect(isoYearWeek(new Date('2024-12-30T12:00:00Z'))).toBe('2025-W01');
    // Two-digit zero-padded week number always.
    expect(isoYearWeek(new Date('2026-03-15T00:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('documentedDelta: UTC-component build is TZ-independent at a fixed UTC instant', () => {
    // Same UTC instant must always produce the same week regardless of the
    // host TZ — this is the property the .ts UTC rewrite guarantees and the
    // .cjs local-component version did NOT (could drift ±1 day near midnight
    // in non-UTC zones). We assert the .ts invariant directly.
    const instant = new Date('2026-05-31T00:30:00Z');
    expect(isoYearWeek(instant)).toBe('2026-W22');
  });
});

// ════════════════════════════════════════════════════════════════════════
// SECTION 2 — buildDigestPrompt FULL byte-equality (the strongest claim)
//   Frozen expected-string literal == the legacy `lines.join('\n')` output.
//   Survives deletion of weekly-digest.cjs. Exercises EVERY branch:
//   13-frame truncation→12, 11-page truncation→10, zero-signal skip,
//   501-char ellipsis, multi-mind ordering, and the '→' / '…' unicode.
// ════════════════════════════════════════════════════════════════════════

describe('buildDigestPrompt — full byte-for-byte golden diff (deletion gate)', () => {
  it('matches the frozen legacy prompt exactly (toBe over every branch)', () => {
    // Bucket A: 13 frames (one is 501 chars → ellipsis), 11 pages.
    const frames13 = Array.from({ length: 13 }, (_, i) => ({
      id: i + 1,
      content: i === 0 ? 'c'.repeat(501) : `frame ${i + 1} body`,
      importance: i % 2 === 0 ? 'important' : 'normal',
      created_at: `2026-05-${String(20 + (i % 10)).padStart(2, '0')} 0${i % 10}:00:00`,
    }));
    const pages11 = Array.from({ length: 11 }, (_, i) => ({
      slug: `slug-${i + 1}`,
      name: `Page ${i + 1}`,
      page_type: i % 2 === 0 ? 'entity' : 'synthesis',
      source_count: (i + 1) * 2,
      compiled_at: `2026-05-25 1${i % 10}:00:00`,
    }));
    const buckets: ActivityBucket[] = [
      { mind: 'personal', frames: frames13, pages: pages11 },
      { mind: 'zero-signal-ws', frames: [], pages: [] }, // must be skipped
      {
        mind: 'beta-ws',
        frames: [{ id: 100, content: 'beta frame', importance: 'critical', created_at: '2026-05-29 09:00:00' }],
        pages: [],
      },
    ];

    const repoPrompt = buildDigestPrompt(
      '2026-W22',
      '2026-05-24 08:00:00',
      '2026-05-31 08:00:00',
      buckets,
    );

    // ── Independent faithful re-implementation of the .cjs buildDigestPrompt
    //    body (weekly-digest.cjs lines 140-191). If the .ts ever drifts from
    //    the .cjs, this toBe fails. Frozen here so it survives .cjs deletion.
    const PER_FRAME_CHARS = 500;
    const PER_BUCKET_FRAMES = 12;
    const PER_BUCKET_PAGES = 10;
    const legacyTrim = (s: string): string => {
      const c = String(s || '').trim();
      return c.length > PER_FRAME_CHARS ? c.slice(0, PER_FRAME_CHARS) + '…' : c;
    };
    const legacyBuild = (
      week: string,
      sinceISO: string,
      untilISO: string,
      bks: ActivityBucket[],
    ): string => {
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
      for (const b of bks) {
        if (b.frames.length === 0 && b.pages.length === 0) continue;
        lines.push(`### Mind: ${b.mind}`);
        if (b.frames.length > 0) {
          lines.push(`Recent frames (${Math.min(b.frames.length, PER_BUCKET_FRAMES)} of ${b.frames.length}):`);
          for (const f of b.frames.slice(0, PER_BUCKET_FRAMES)) {
            lines.push(`- (${f.importance}) ${f.created_at}: ${legacyTrim(f.content)}`);
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
    };

    const legacyPrompt = legacyBuild(
      '2026-W22',
      '2026-05-24 08:00:00',
      '2026-05-31 08:00:00',
      buckets,
    );

    // THE GATE: byte-for-byte identical .ts vs faithful .cjs port.
    expect(repoPrompt).toBe(legacyPrompt);

    // ── Branch-coverage spot assertions on the SAME output ──────────────
    // 12-of-13 truncation header + only 12 frame lines render.
    expect(repoPrompt).toContain('Recent frames (12 of 13):');
    expect(repoPrompt).not.toContain('frame 13 body'); // 13th frame dropped
    expect(repoPrompt).toContain('frame 12 body'); // 12th frame kept
    // 10-of-11 truncation header + 11th page dropped.
    expect(repoPrompt).toContain('Recent wiki pages (10 of 11):');
    expect(repoPrompt).toContain('`slug-10`');
    expect(repoPrompt).not.toContain('`slug-11`');
    // Zero-signal bucket skipped entirely.
    expect(repoPrompt).not.toContain('### Mind: zero-signal-ws');
    // Multi-mind ordering: personal block precedes beta-ws block.
    expect(repoPrompt.indexOf('### Mind: personal')).toBeLessThan(repoPrompt.indexOf('### Mind: beta-ws'));
    // 501-char frame got the ellipsis (first frame in bucket A).
    expect(repoPrompt).toContain('- (important) 2026-05-20 00:00:00: ' + 'c'.repeat(500) + '…');
    // Unicode locked: arrow in WEEK line, ellipsis in trimmed frame.
    expect(repoPrompt).toContain('→');
    expect(repoPrompt).toContain('…');
    // Blank line is pushed after each non-empty bucket: the line right
    // after the last beta-ws frame and before the trailing instruction is ''.
    const betaIdx = repoPrompt.indexOf('- (critical) 2026-05-29 09:00:00: beta frame');
    const tail = repoPrompt.slice(betaIdx);
    expect(tail).toBe('- (critical) 2026-05-29 09:00:00: beta frame\n\nNow emit the digest in the exact format above.');
  });
});

// ════════════════════════════════════════════════════════════════════════
// SECTION 3 — runDigest integration: SQL semantics, ordering, short-circuit,
//   dry-run, real-run footer/attribution. Hermetic + deterministic.
// ════════════════════════════════════════════════════════════════════════

describe('runDigest — hermetic integration (coverageGap fill)', () => {
  let dataDir: string;
  let digestDir: string;
  let env: CliEnv;
  const NOW = Date.now();
  const fresh = (offsetMs: number): string =>
    new Date(NOW - offsetMs).toISOString().slice(0, 19).replace('T', ' ');

  beforeEach(() => {
    process.env.HIVE_MIND_NO_RERANK = '1';
    dataDir = mkdtempSync(join(tmpdir(), 'hmind-digest-data-'));
    digestDir = mkdtempSync(join(tmpdir(), 'hmind-digest-out-'));
    process.env.HIVE_MIND_DIGEST_DIR = digestDir;
    env = openPersonalMind(dataDir);
    // reset spawn mock state per test
    spawnCalls.length = 0;
    mockExitCode = 0;
    mockStdout = 'MOCK DIGEST BODY';
    mockStderr = '';
  });

  afterEach(() => {
    env.close();
    delete process.env.HIVE_MIND_DIGEST_DIR;
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(digestDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('empty-activity short-circuit: no spawn, no file, digested:false', async () => {
    const res = await runDigest({ env, week: '2026-W22' });
    expect(res.digested).toBe(false);
    // documentedDelta vs .cjs ('nothing to digest' to stderr): .ts uses reason.
    expect(res.reason).toBe('no activity in the last 7 days');
    expect(res.totalFrames).toBe(0);
    expect(res.totalPages).toBe(0);
    expect(spawnCalls.length).toBe(0); // no claude -p
    expect(readdirSync(digestDir)).toEqual([]); // no file written
  });

  it('SQL semantics: excludes temporary + deprecated; keeps critical/important/normal; respects page_type IN list; newest first', async () => {
    const db = env.db.getDatabase();
    // Frames: 3 surfaced (critical/important/normal) + 2 excluded (temporary/deprecated).
    insertFrame(db, 'normal frame', 'normal', fresh(60_000));
    insertFrame(db, 'important frame', 'important', fresh(50_000));
    insertFrame(db, 'critical frame', 'critical', fresh(40_000));
    insertFrame(db, 'temp frame', 'temporary', fresh(30_000)); // excluded
    insertFrame(db, 'dep frame', 'deprecated', fresh(20_000)); // excluded
    // Pages: 3 allowed (entity/synthesis/concept) + 1 excluded (other type).
    insertPage(db, 'ent-1', 'Entity One', 'entity', 5, fresh(55_000));
    insertPage(db, 'syn-1', 'Synth One', 'synthesis', 6, fresh(45_000));
    insertPage(db, 'con-1', 'Concept One', 'concept', 7, fresh(35_000));
    insertPage(db, 'oth-1', 'Other One', 'guide', 8, fresh(25_000)); // excluded

    const res = await runDigest({ env, week: '2026-W22', dryRun: true });
    expect(res.totalFrames).toBe(3); // temporary + deprecated dropped
    expect(res.totalPages).toBe(3); // 'guide' page dropped
    const p = res.prompt as string;
    expect(p).toContain('critical frame');
    expect(p).toContain('important frame');
    expect(p).toContain('normal frame');
    expect(p).not.toContain('temp frame');
    expect(p).not.toContain('dep frame');
    expect(p).toContain('`ent-1`');
    expect(p).toContain('`syn-1`');
    expect(p).toContain('`con-1`');
    expect(p).not.toContain('`oth-1`');
    // ORDER BY created_at DESC: newest (critical, freshest) appears before
    // normal (oldest of the three) in the rendered frame block.
    expect(p.indexOf('critical frame')).toBeLessThan(p.indexOf('normal frame'));
    // Header reflects the post-filter count.
    expect(p).toContain('Recent frames (3 of 3):');
    expect(p).toContain('Recent wiki pages (3 of 3):');
  });

  it('SQL LIMIT: 100 frames cap and 50 pages cap (bucket header caps stay 12/10)', async () => {
    const db = env.db.getDatabase();
    // 120 frames — query LIMIT 100 trims to 100; bucket render caps at 12.
    for (let i = 0; i < 120; i++) insertFrame(db, `bulk frame ${i}`, 'normal', fresh(1_000_000 - i * 1000));
    // 60 pages — query LIMIT 50 trims to 50; bucket render caps at 10.
    for (let i = 0; i < 60; i++) insertPage(db, `bulk-${i}`, `Bulk ${i}`, 'entity', 1, fresh(900_000 - i * 1000));

    const res = await runDigest({ env, week: '2026-W22', dryRun: true });
    expect(res.totalFrames).toBe(100); // SQL LIMIT 100
    expect(res.totalPages).toBe(50); // SQL LIMIT 50
    const p = res.prompt as string;
    expect(p).toContain('Recent frames (12 of 100):'); // Math.min(100,12) of 100
    expect(p).toContain('Recent wiki pages (10 of 50):'); // Math.min(50,10) of 50
  });

  it('multi-mind ordering: personal first, then workspaces ascending by id', async () => {
    // Seed personal + two workspaces CREATED OUT OF ORDER (beta then alpha)
    // so the test proves runDigest's own ascending id sort, not creation
    // order. WorkspaceManager.create takes {name, group}; ids slugify the
    // name ('beta' → 'beta', 'alpha' → 'alpha').
    insertFrame(env.db.getDatabase(), 'personal activity', 'normal', fresh(10_000));
    const beta = env.workspaces.create({ name: 'beta', group: 'test' });
    const alpha = env.workspaces.create({ name: 'alpha', group: 'test' });
    expect(beta.id).toBe('beta');
    expect(alpha.id).toBe('alpha');
    const betaDb = env.mindCache.getOrOpen(beta.id);
    const alphaDb = env.mindCache.getOrOpen(alpha.id);
    insertFrame(betaDb!.getDatabase(), 'beta activity', 'normal', fresh(9_000));
    insertFrame(alphaDb!.getDatabase(), 'alpha activity', 'normal', fresh(8_000));

    const res = await runDigest({ env, week: '2026-W22', dryRun: true });
    const p = res.prompt as string;
    const iPersonal = p.indexOf('### Mind: personal');
    const iAlpha = p.indexOf('### Mind: alpha');
    const iBeta = p.indexOf('### Mind: beta');
    expect(iPersonal).toBeGreaterThanOrEqual(0);
    expect(iAlpha).toBeGreaterThan(iPersonal); // personal first
    expect(iBeta).toBeGreaterThan(iAlpha); // alpha before beta (id ascending)
    expect(res.totalFrames).toBe(3);
  });

  it('missing-table resilience: a mind without wiki_pages still contributes frames (pages query swallowed)', async () => {
    // A freshly-opened MindDB has NO wiki_pages table (the core schema does
    // not create it — the wiki-compiler does). So the pages query throws
    // "no such table: wiki_pages", which the try/catch swallows → [] pages,
    // while the frames query still runs. This is the exact production state
    // of a mind that was never compiled.
    const db = env.db.getDatabase();
    const hasWiki = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages'`)
      .get();
    expect(hasWiki).toBeUndefined(); // table genuinely absent by default
    insertFrame(db, 'personal frame', 'normal', fresh(5_000));
    const res = await runDigest({ env, week: '2026-W22', dryRun: true });
    expect(res.totalFrames).toBe(1);
    expect(res.totalPages).toBe(0); // swallowed query → []
    expect(res.prompt as string).toContain('personal frame');
  });

  it('missing-table resilience: a broken frames query is swallowed but pages still surface', async () => {
    // Inverse resilience: rename memory_frames so the frames query throws,
    // and assert the pages query still runs and surfaces a page. Proves the
    // two try/catch blocks are independent (invariant: one failing query
    // yields [] without taking down the other).
    const db = env.db.getDatabase();
    insertPage(db, 'lonely', 'Lonely Page', 'concept', 4, fresh(4_000));
    db.exec('ALTER TABLE memory_frames RENAME TO memory_frames_hidden');
    const res = await runDigest({ env, week: '2026-W22', dryRun: true });
    expect(res.totalFrames).toBe(0); // frames query swallowed → []
    expect(res.totalPages).toBe(1); // pages query still ran
    expect(res.prompt as string).toContain('`lonely`');
    // restore so afterEach close() / cleanup is well-behaved
    db.exec('ALTER TABLE memory_frames_hidden RENAME TO memory_frames');
  });

  it('--dry-run is side-effect-free: returns {prompt, digested:false, reason:"dry-run"}, NO spawn, NO file', async () => {
    insertFrame(env.db.getDatabase(), 'dry run frame', 'important', fresh(3_000));
    const res = await runDigest({ env, week: '2026-W22', dryRun: true });
    expect(res.digested).toBe(false);
    expect(res.reason).toBe('dry-run');
    expect(typeof res.prompt).toBe('string');
    expect(res.prompt as string).toContain('dry run frame');
    // documentedDelta: .cjs writes prompt to STDOUT; .ts returns it on
    // DigestResult.prompt (CLI wrapper prints). Assert the return shape.
    expect(res.outPath).toBeUndefined();
    expect(spawnCalls.length).toBe(0); // no claude -p in dry-run
    expect(readdirSync(digestDir)).toEqual([]); // no file written
  });

  it('real run: spawn contract + footer/attribution template + outPath honoring HIVE_MIND_DIGEST_DIR', async () => {
    insertFrame(env.db.getDatabase(), 'real frame one', 'critical', fresh(2_000));
    insertPage(env.db.getDatabase(), 'rp-1', 'Real Page', 'entity', 9, fresh(2_500));
    mockStdout = '  # Week 2026-W22\n- did things  '; // leading/trailing ws → trimmed

    const res = await runDigest({ env, week: '2026-W22' });
    expect(res.digested).toBe(true);
    expect(res.totalFrames).toBe(1);
    expect(res.totalPages).toBe(1);

    // spawn contract: claude -p --output-format=text, HIVE_MIND_NO_SYNTH=1,
    // prompt written to stdin.
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].cmd).toBe('claude');
    expect(spawnCalls[0].args).toEqual(['-p', '--output-format=text']);
    expect((spawnCalls[0].opts.env as Record<string, string>).HIVE_MIND_NO_SYNTH).toBe('1');
    expect(spawnCalls[0].stdin).toContain('### Mind: personal');
    expect(spawnCalls[0].stdin).toContain('real frame one');

    // outPath = <HIVE_MIND_DIGEST_DIR>/<week>.md
    expect(res.outPath).toBe(join(digestDir, '2026-W22.md'));
    expect(existsSync(res.outPath as string)).toBe(true);

    // finalContent template, with the .ts attribution rebrand.
    const written = readFileSync(res.outPath as string, 'utf8');
    const expectedFooter = '\n\n---\n_Generated ';
    expect(written.startsWith('# Week 2026-W22\n- did things')).toBe(true); // claude stdout trimmed
    expect(written).toContain(expectedFooter);
    // documentedDelta (footer attribution): .ts says "hive-mind digest",
    // NOT the .cjs "D:/Projects/.harvest/weekly-digest.cjs".
    expect(written).toContain(' by hive-mind digest · 1 frames + 1 pages from last 7 days_\n');
    expect(written).not.toContain('weekly-digest.cjs');
    expect(written.endsWith('from last 7 days_\n')).toBe(true);
  });

  it('real run: non-zero claude exit rejects with the documented message', async () => {
    insertFrame(env.db.getDatabase(), 'will fail', 'normal', fresh(1_000));
    mockExitCode = 7;
    mockStderr = 'boom stderr detail';
    await expect(runDigest({ env, week: '2026-W22' })).rejects.toThrow(/claude -p exited 7: boom stderr detail/);
    // Failed generation must not leave a partial digest file.
    expect(readdirSync(digestDir)).toEqual([]);
  });

  it('documentedDelta (lifecycle): caller-provided env is NOT closed by runDigest', async () => {
    insertFrame(env.db.getDatabase(), 'lifecycle frame', 'normal', fresh(1_500));
    await runDigest({ env, week: '2026-W22', dryRun: true });
    // If runDigest had closed the injected env, this query would throw.
    const row = env.db
      .getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM memory_frames')
      .get() as { n: number };
    expect(row.n).toBeGreaterThanOrEqual(1); // db still open + usable
  });
});

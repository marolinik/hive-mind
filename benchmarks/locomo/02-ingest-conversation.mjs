#!/usr/bin/env node
// Phase 2 — Ingest LoCoMo conversation as memory frames
//
// Walks one LoCoMo conversation (default: RUN.json's conv_idx) and writes
// each dialogue turn as an IFrame in the test workspace's mind.db.
//
// Frame shape (content):
//
//     [locomo conv:<sample_id> dia:<dia_id> speaker:<S> ts:<orig_dt>]
//     <turn text>
//
// The `dia:<dia_id>` substring is the deterministic anchor for
// evidence_recall@5 in Phase 5. The `ts:<orig_dt>` is the human-
// readable LoCoMo session timestamp; we ALSO pass a parsed ISO-8601
// timestamp through to FrameStore.createIFrame's `createdAt` arg so
// the frame's own `created_at` column reflects the dialogue's
// original 2023 wall-clock time — this is what makes temporal-
// category queries meaningful.
//
// Library mode (no MCP). HIVE_MIND_NO_SYNTH=1 is set defensively even
// though direct FrameStore writes don't trigger the synth queue.

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR_LOCAL = resolve(__dirname, 'data');
const RUN_FILE = resolve(DATA_DIR_LOCAL, 'RUN.json');
const DATASET_FILE = resolve(DATA_DIR_LOCAL, 'locomo10.json');

const HIVE_MIND_ROOT = process.env.HIVE_MIND_ROOT ?? resolve(__dirname, '..', '..');
const FRAMES_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/mind/frames.js`).href;
const DB_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/mind/db.js`).href;

function loadRun() {
  if (!existsSync(RUN_FILE)) throw new Error(`RUN.json missing — run 01-prepare-workspace.mjs first.`);
  return JSON.parse(readFileSync(RUN_FILE, 'utf8'));
}

function loadDataset(expectedSha) {
  if (!existsSync(DATASET_FILE)) throw new Error(`Dataset missing at ${DATASET_FILE}`);
  const buf = readFileSync(DATASET_FILE);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (expectedSha && sha !== expectedSha) {
    throw new Error(
      `Dataset SHA256 drift detected — RUN.json was pinned to ${expectedSha} ` +
      `but on-disk file hashes to ${sha}. Refusing to ingest into a workspace ` +
      `that may not match downstream phases. Re-fetch and re-prepare.`,
    );
  }
  return JSON.parse(buf.toString('utf8'));
}

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

/** Parse LoCoMo session date_time strings, e.g. "1:56 pm on 8 May, 2023" → ISO UTC.
 *  Returns null on parse failure (caller will let the schema default fire). */
function parseLocomoDateTime(s) {
  if (!s || typeof s !== 'string') return null;
  // Primary pattern: "H:MM (am|pm) on D Month, YYYY"
  const m = s.match(/^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (m) {
    const [, h, mm, ampm, d, monthRaw, y] = m;
    const mon = MONTHS[monthRaw.slice(0, 3).toLowerCase()];
    if (mon === undefined) return null;
    let hour = parseInt(h, 10);
    if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
    const dt = new Date(Date.UTC(parseInt(y, 10), mon, parseInt(d, 10), hour, parseInt(mm, 10)));
    return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
  }
  // Fallback: native parse for any other shape we haven't seen.
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Sort session keys numerically: session_2 < session_10. */
function sortedSessionKeys(conversation) {
  return Object.keys(conversation)
    .filter(k => /^session_\d+$/.test(k) && Array.isArray(conversation[k]))
    .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10));
}

async function main() {
  const run = loadRun();
  const data = loadDataset(run.dataset_sha256);
  const convIdxArg = process.argv.find(a => a.startsWith('--conv-idx='));
  const convIdx = convIdxArg ? parseInt(convIdxArg.split('=')[1], 10) : run.conv_idx;
  const dryRun = process.argv.includes('--dry-run');

  if (convIdx < 0 || convIdx >= data.length) {
    throw new Error(`conv_idx ${convIdx} out of range (0..${data.length - 1})`);
  }
  const conv = data[convIdx];
  const sampleId = conv.sample_id ?? `idx-${convIdx}`;

  const { MindDB } = await import(DB_URL);
  const { FrameStore } = await import(FRAMES_URL);

  const db = new MindDB(run.mind_path);
  const frames = new FrameStore(db);
  const raw = db.getDatabase();

  // memory_frames.gop_id has FK → sessions(gop_id). We seed one closed
  // `sessions` row per LoCoMo session before writing any frames so the
  // FK is satisfied. INSERT OR IGNORE makes the seed step idempotent on
  // re-run. project_id 'locomo-replay' lets us scope cleanup by query.
  const seedSession = raw.prepare(
    `INSERT OR IGNORE INTO sessions (gop_id, project_id, status, started_at, summary)
     VALUES (?, 'locomo-replay', 'closed', COALESCE(?, datetime('now')), ?)`,
  );

  let writtenCount = 0;
  let dedupedCount = 0;
  let timestampParseFailures = 0;
  let totalTurns = 0;
  let sessionsSeeded = 0;
  const skipped = []; // [{session_key, reason}]

  try {
    const sessionKeys = sortedSessionKeys(conv.conversation);
    console.log(`[ingest] conv_idx=${convIdx} sample_id=${sampleId} sessions=${sessionKeys.length}`);

    for (const sk of sessionKeys) {
      const sessionNum = parseInt(sk.split('_')[1], 10);
      const dtRaw = conv.conversation[`${sk}_date_time`] ?? null;
      const isoTs = parseLocomoDateTime(dtRaw);
      if (dtRaw && !isoTs) timestampParseFailures++;

      const turns = conv.conversation[sk];
      const gopId = `locomo-${sampleId}-s${sessionNum}`;
      if (!dryRun) {
        const summary = `LoCoMo ${sampleId} session ${sessionNum} (${turns.length} turns) — ${dtRaw ?? 'no-ts'}`;
        const result = seedSession.run(gopId, isoTs, summary);
        if (result.changes === 1) sessionsSeeded++;
      }

      for (const turn of turns) {
        totalTurns++;
        if (!turn || typeof turn.text !== 'string' || !turn.text.trim()) {
          skipped.push({ session: sk, dia_id: turn?.dia_id, reason: 'empty-text' });
          continue;
        }
        const tsLabel = dtRaw ?? '';
        const content = `[locomo conv:${sampleId} dia:${turn.dia_id} speaker:${turn.speaker} ts:${tsLabel}]\n${turn.text}`;

        if (dryRun) { writtenCount++; continue; }

        const before = frames.getStats?.()?.totalFrames;
        const f = frames.createIFrame(gopId, content, 'temporary', 'system', isoTs);
        // createIFrame returns existing frame on dedup; detect by checking
        // whether stats moved. Cheaper: most LoCoMo turns are unique, so
        // a positive dedup count would mean the data has identical lines.
        if (typeof before === 'number') {
          const after = frames.getStats?.()?.totalFrames;
          if (typeof after === 'number' && after === before) dedupedCount++;
          else writtenCount++;
        } else {
          writtenCount++;
        }
      }
    }

    // Final on-disk count of test frames in this workspace mind, for verification
    const raw = db.getDatabase();
    const counted = raw
      .prepare(`SELECT COUNT(*) AS n FROM memory_frames WHERE source = 'system' AND importance = 'temporary'`)
      .get();
    const sample = raw
      .prepare(`SELECT id, content, created_at FROM memory_frames WHERE source = 'system' AND importance = 'temporary' ORDER BY id ASC LIMIT 1`)
      .get();

    console.log(`[done]  dryRun=${dryRun}`);
    console.log(`        sessions seen          : ${sessionKeys.length}`);
    console.log(`        turns visited          : ${totalTurns}`);
    console.log(`        frames written         : ${writtenCount}`);
    console.log(`        frames deduped (skipped): ${dedupedCount}`);
    console.log(`        skipped (empty text)   : ${skipped.length}`);
    console.log(`        ts parse failures      : ${timestampParseFailures}`);
    console.log(`        on-disk test frames    : ${counted?.n ?? '?'}`);
    if (sample) {
      console.log(`        sample frame.id        : ${sample.id}`);
      console.log(`        sample created_at      : ${sample.created_at}`);
      console.log(`        sample content[0..120] : ${String(sample.content).slice(0, 120).replace(/\n/g, ' ⏎ ')}`);
    }
  } finally {
    db.close();
  }
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

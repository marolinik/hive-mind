#!/usr/bin/env node
// Phase 2-extended — Ingest LoCoMo conversations 1-9 (conv 0 already done)
//
// One workspace per conversation: `proj-locomo-all-c<idx>`. Per-conv
// workspaces keep the per-cell measurements clean (questions about conv-26
// shouldn't be able to retrieve conv-37's frames). RUN-all.json is the
// multi-conv manifest pointing at all 10 workspaces and the dataset SHA.

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR_LOCAL = resolve(__dirname, 'data');
const RUN_FILE = resolve(DATA_DIR_LOCAL, 'RUN.json');
const RUN_ALL_FILE = resolve(DATA_DIR_LOCAL, 'RUN-all.json');
const MANIFEST_FILE = resolve(DATA_DIR_LOCAL, 'MANIFEST.json');
const DATASET_FILE = resolve(DATA_DIR_LOCAL, 'locomo10.json');

const HIVE_MIND_ROOT = process.env.HIVE_MIND_ROOT ?? resolve(__dirname, '..', '..');
const SETUP_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/setup.js`).href;
const WM_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/workspace-manager.js`).href;
const FRAMES_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/mind/frames.js`).href;
const DB_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/mind/db.js`).href;

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function parseLocomoDateTime(s) {
  if (!s || typeof s !== 'string') return null;
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
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function sortedSessionKeys(conversation) {
  return Object.keys(conversation)
    .filter(k => /^session_\d+$/.test(k) && Array.isArray(conversation[k]))
    .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10));
}

async function ingestOneConv(convIdx, conv, expectedSha, modules) {
  const { resolveDataDir } = modules;
  const { WorkspaceManager } = modules;
  const { MindDB } = modules;
  const { FrameStore } = modules;

  const dataDir = resolveDataDir();
  const wsId = `proj-locomo-all-c${convIdx}`;
  const wm = new WorkspaceManager(dataDir);
  const ws = wm.ensure(wsId, {
    name: `LoCoMo all c${convIdx} (${conv.sample_id})`,
    group: 'measurement',
  });
  const mindPath = wm.getMindPath(wsId);

  const db = new MindDB(mindPath);
  const frames = new FrameStore(db);
  const raw = db.getDatabase();
  const seedSession = raw.prepare(
    `INSERT OR IGNORE INTO sessions (gop_id, project_id, status, started_at, summary)
     VALUES (?, 'locomo-replay', 'closed', COALESCE(?, datetime('now')), ?)`,
  );

  let written = 0, skipped = 0, tsFails = 0, sessionsCount = 0;
  try {
    const sks = sortedSessionKeys(conv.conversation);
    for (const sk of sks) {
      const sessionNum = parseInt(sk.split('_')[1], 10);
      const dtRaw = conv.conversation[`${sk}_date_time`] ?? null;
      const isoTs = parseLocomoDateTime(dtRaw);
      if (dtRaw && !isoTs) tsFails++;
      const turns = conv.conversation[sk];
      const gopId = `locomo-${conv.sample_id}-s${sessionNum}`;
      const summary = `LoCoMo ${conv.sample_id} session ${sessionNum} (${turns.length} turns) — ${dtRaw ?? 'no-ts'}`;
      const r = seedSession.run(gopId, isoTs, summary);
      if (r.changes === 1) sessionsCount++;
      for (const turn of turns) {
        if (!turn || typeof turn.text !== 'string' || !turn.text.trim()) { skipped++; continue; }
        const tsLabel = dtRaw ?? '';
        const content = `[locomo conv:${conv.sample_id} dia:${turn.dia_id} speaker:${turn.speaker} ts:${tsLabel}]\n${turn.text}`;
        frames.createIFrame(gopId, content, 'temporary', 'system', isoTs);
        written++;
      }
    }
    const totalFrames = raw.prepare(`SELECT COUNT(*) AS n FROM memory_frames WHERE source='system' AND importance='temporary'`).get().n;
    return { workspace: ws.id, mind_path: mindPath, sample_id: conv.sample_id, sessions_added: sessionsCount, frames_written: written, frames_skipped: skipped, ts_parse_failures: tsFails, on_disk: totalFrames };
  } finally {
    db.close();
  }
}

async function main() {
  if (!existsSync(MANIFEST_FILE)) throw new Error(`MANIFEST.json missing — run 00-fetch first`);
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const buf = readFileSync(DATASET_FILE);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== manifest.sha256) throw new Error(`Dataset SHA drift: ${sha} vs ${manifest.sha256}`);
  const data = JSON.parse(buf.toString('utf8'));

  const setup = await import(SETUP_URL);
  const wmMod = await import(WM_URL);
  const dbMod = await import(DB_URL);
  const fsMod = await import(FRAMES_URL);
  const modules = { resolveDataDir: setup.resolveDataDir, WorkspaceManager: wmMod.WorkspaceManager, MindDB: dbMod.MindDB, FrameStore: fsMod.FrameStore };

  // Carry forward conv 0 from existing RUN.json if present.
  const existing = existsSync(RUN_FILE) ? JSON.parse(readFileSync(RUN_FILE, 'utf8')) : null;
  const allRuns = [];

  console.log(`[ingest-all] data has ${data.length} convs, sha=${sha.slice(0,16)}...`);
  for (let i = 0; i < data.length; i++) {
    const conv = data[i];
    if (i === 0 && existing) {
      // Reuse the existing conv-0 workspace (proj-locomo-<ts>), don't create proj-locomo-all-c0.
      console.log(`  conv ${i} sample=${conv.sample_id}: reusing existing workspace=${existing.workspace}`);
      allRuns.push({
        conv_idx: i, sample_id: conv.sample_id,
        workspace: existing.workspace, mind_path: existing.mind_path,
        reused: true,
      });
      continue;
    }
    const t0 = Date.now();
    const r = await ingestOneConv(i, conv, manifest.sha256, modules);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  conv ${i} sample=${conv.sample_id}: workspace=${r.workspace} frames=${r.frames_written} sessions=${r.sessions_added} ts-fails=${r.ts_parse_failures} (${dt}s)`);
    allRuns.push({ conv_idx: i, ...r });
  }

  const runAll = {
    dataset_sha256: manifest.sha256,
    dataset_url: manifest.source_url,
    started_at: new Date().toISOString(),
    convs: allRuns,
  };
  writeFileSync(RUN_ALL_FILE, JSON.stringify(runAll, null, 2));
  console.log(`[done] RUN-all.json -> ${RUN_ALL_FILE}`);
  const totalFrames = allRuns.reduce((s, r) => s + (r.frames_written || 0), 0);
  console.log(`       total frames written this run: ${totalFrames} (across ${allRuns.length - (existing ? 1 : 0)} new convs)`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

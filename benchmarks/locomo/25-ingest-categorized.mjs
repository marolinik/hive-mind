#!/usr/bin/env node
// Track A Fix #1 — Add categorized "memory fact" frames alongside raw turns.
//
// Saves three new frame types to each per-conv workspace:
//   1. session_summary  → [locomo session-summary conv:X session:N ts:T] <para>  (importance: important)
//   2. observation      → [locomo observation conv:X dia:D speaker:S] <obs>       (importance: important)
//   3. event            → [locomo event conv:X session:N speaker:S ts:T] <event> (importance: normal)
//
// These are LoCoMo's own pre-distilled summaries — equivalent to what Mem0's
// 4-pass harvest pipeline produces. By saving them as importance-tagged frames
// alongside the raw turns, we exercise Layer 4 of the production memory pattern.

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_ALL_FILE = resolve(__dirname, 'data', 'RUN-all.json');
const DATASET = resolve(__dirname, 'data', 'locomo10.json');

const HIVE_MIND_ROOT = 'D:/Projects/hive-mind';
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
  // Date-only fallback for event_summary['date']: "8 May, 2023"
  const m2 = s.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
  if (m2) {
    const [, d, monthRaw, y] = m2;
    const mon = MONTHS[monthRaw.slice(0,3).toLowerCase()];
    if (mon !== undefined) {
      const dt = new Date(Date.UTC(parseInt(y,10), mon, parseInt(d,10), 12, 0));
      return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
    }
  }
  return null;
}

function ingestConv(conv, db, frames, raw) {
  const sampleId = conv.sample_id;
  let summariesAdded = 0, observationsAdded = 0, eventsAdded = 0;

  // Seed sessions for new gop_ids (FK constraint)
  const seed = raw.prepare(
    `INSERT OR IGNORE INTO sessions (gop_id, project_id, status, started_at, summary)
     VALUES (?, 'locomo-replay', 'closed', datetime('now'), ?)`,
  );
  for (const cat of ['summaries','observations','events']) {
    seed.run(`locomo-${sampleId}-${cat}`, `LoCoMo ${sampleId} ${cat} (categorized)`);
  }

  // 1. session_summary — long natural-language paragraphs, importance: important
  if (conv.session_summary) {
    for (const [k, summary] of Object.entries(conv.session_summary)) {
      if (typeof summary !== 'string' || !summary.trim()) continue;
      const m = k.match(/^session_(\d+)_summary$/);
      if (!m) continue;
      const sessionN = m[1];
      const dtRaw = conv.conversation?.[`session_${sessionN}_date_time`] ?? null;
      const isoTs = parseLocomoDateTime(dtRaw);
      const tsLabel = dtRaw ?? '';
      const content = `[locomo session-summary conv:${sampleId} session:${sessionN} ts:${tsLabel}]\n${summary}`;
      frames.createIFrame(`locomo-${sampleId}-summaries`, content, 'important', 'system', isoTs);
      summariesAdded++;
    }
  }

  // 2. observation — [text, dia_id] tuples per speaker, importance: important
  if (conv.observation) {
    for (const [k, sessionObs] of Object.entries(conv.observation)) {
      if (typeof sessionObs !== 'object' || !sessionObs) continue;
      const m = k.match(/^session_(\d+)_observation$/);
      if (!m) continue;
      const sessionN = m[1];
      const dtRaw = conv.conversation?.[`session_${sessionN}_date_time`] ?? null;
      const isoTs = parseLocomoDateTime(dtRaw);
      for (const [speaker, obsList] of Object.entries(sessionObs)) {
        if (!Array.isArray(obsList)) continue;
        for (const item of obsList) {
          if (!Array.isArray(item) || item.length < 1) continue;
          const obsText = String(item[0] || '').trim();
          const diaId = item.length > 1 ? String(item[1] || '') : '';
          if (!obsText) continue;
          const content = `[locomo observation conv:${sampleId} dia:${diaId} speaker:${speaker} session:${sessionN}]\n${obsText}`;
          frames.createIFrame(`locomo-${sampleId}-observations`, content, 'important', 'system', isoTs);
          observationsAdded++;
        }
      }
    }
  }

  // 3. event_summary — per-speaker event lists, importance: normal
  if (conv.event_summary) {
    for (const [k, sessionEvents] of Object.entries(conv.event_summary)) {
      if (typeof sessionEvents !== 'object' || !sessionEvents) continue;
      const m = k.match(/^events_session_(\d+)$/);
      if (!m) continue;
      const sessionN = m[1];
      const eventDate = sessionEvents.date || conv.conversation?.[`session_${sessionN}_date_time`] || '';
      const isoTs = parseLocomoDateTime(eventDate);
      for (const [speaker, eventList] of Object.entries(sessionEvents)) {
        if (speaker === 'date' || !Array.isArray(eventList)) continue;
        for (const event of eventList) {
          const eventText = String(event || '').trim();
          if (!eventText) continue;
          const content = `[locomo event conv:${sampleId} session:${sessionN} speaker:${speaker} ts:${eventDate}]\n${eventText}`;
          frames.createIFrame(`locomo-${sampleId}-events`, content, 'normal', 'system', isoTs);
          eventsAdded++;
        }
      }
    }
  }

  return { summariesAdded, observationsAdded, eventsAdded };
}

async function main() {
  const runAll = JSON.parse(readFileSync(RUN_ALL_FILE, 'utf8'));
  const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
  const { MindDB } = await import(DB_URL);
  const { FrameStore } = await import(FRAMES_URL);

  let totalSummaries = 0, totalObservations = 0, totalEvents = 0;
  for (const c of runAll.convs) {
    const conv = dataset[c.conv_idx];
    const db = new MindDB(c.mind_path);
    const frames = new FrameStore(db);
    const raw = db.getDatabase();
    try {
      const r = ingestConv(conv, db, frames, raw);
      console.log(`  c${c.conv_idx} ${c.sample_id} → summaries=${r.summariesAdded} observations=${r.observationsAdded} events=${r.eventsAdded}`);
      totalSummaries += r.summariesAdded;
      totalObservations += r.observationsAdded;
      totalEvents += r.eventsAdded;
    } finally { db.close(); }
  }
  const total = totalSummaries + totalObservations + totalEvents;
  console.log(`[done] across 10 workspaces: summaries=${totalSummaries} observations=${totalObservations} events=${totalEvents} | total categorized frames=${total}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

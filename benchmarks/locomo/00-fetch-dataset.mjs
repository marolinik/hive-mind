#!/usr/bin/env node
// Phase 0 — Fetch LoCoMo dataset
//
// Downloads snap-research/locomo dataset (locomo10.json) from GitHub raw,
// stores it under scripts/locomo/data/, computes SHA256, and prints a
// schema summary so phases 2-5 can be written defensively against the
// real shape of the data.
//
// Source: https://github.com/snap-research/locomo (the paper repo).
// We pin to the file path on `main` and verify SHA256 on subsequent
// runs so a silent dataset rewrite cannot poison a measurement.

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const OUT_FILE = resolve(DATA_DIR, 'locomo10.json');
const MANIFEST = resolve(DATA_DIR, 'MANIFEST.json');

const SOURCE_URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';
const GIT_BLOB_SHA = 'd95b872480b413d935821fdc3c84f8a8f5f29e73';

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function downloadTo(url, outPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outPath, buf);
  return buf;
}

function summarizeShape(json) {
  // Defensive: handle either a top-level array of conversations OR an object with a key.
  const conversations = Array.isArray(json) ? json : (json.conversations || json.dialogs || []);
  const summary = {
    top_level: Array.isArray(json) ? `array(${json.length})` : `object(keys=${Object.keys(json).join(',')})`,
    conversation_count: conversations.length,
  };
  if (conversations.length === 0) return summary;
  const c0 = conversations[0];
  summary.conv0_keys = Object.keys(c0);
  // Different LoCoMo dumps name the conversation field "conversation", "dialog", or "session_*".
  // Probe in order.
  const turnsField = ['conversation', 'session_1', 'dialog', 'turns'].find(k => Array.isArray(c0[k]));
  if (turnsField) {
    summary.conv0_turns_field = turnsField;
    summary.conv0_turn_count = c0[turnsField].length;
    if (c0[turnsField].length > 0) summary.conv0_turn_keys = Object.keys(c0[turnsField][0]);
  } else {
    // Maybe conversations are stored as session_1, session_2, ... at top level of c0.
    const sessionKeys = Object.keys(c0).filter(k => /^session_/.test(k) || /^conversation_session_/.test(k));
    if (sessionKeys.length > 0) {
      summary.conv0_session_keys = sessionKeys;
      const firstSession = c0[sessionKeys[0]];
      if (Array.isArray(firstSession)) {
        summary.conv0_first_session_turn_count = firstSession.length;
        if (firstSession.length > 0) summary.conv0_first_session_turn_keys = Object.keys(firstSession[0]);
      }
    }
  }
  // QA bank
  const qaField = ['qa', 'questions', 'qa_pairs'].find(k => Array.isArray(c0[k]));
  if (qaField) {
    summary.conv0_qa_field = qaField;
    summary.conv0_qa_count = c0[qaField].length;
    if (c0[qaField].length > 0) summary.conv0_qa_keys = Object.keys(c0[qaField][0]);
    // Distinct categories
    const cats = new Set();
    for (const q of c0[qaField]) {
      const c = q.category ?? q.type ?? q.qa_type;
      if (c !== undefined) cats.add(String(c));
    }
    if (cats.size > 0) summary.conv0_qa_categories = [...cats];
  }
  return summary;
}

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  let buf;
  if (existsSync(OUT_FILE) && process.argv.includes('--skip-fetch')) {
    console.log(`[skip-fetch] reading existing ${OUT_FILE}`);
    buf = readFileSync(OUT_FILE);
  } else {
    console.log(`[fetch] ${SOURCE_URL}`);
    buf = await downloadTo(SOURCE_URL, OUT_FILE);
    console.log(`[ok] wrote ${OUT_FILE} (${buf.length.toLocaleString()} bytes)`);
  }

  const sha = sha256Of(buf);
  console.log(`[sha256] ${sha}`);

  let json;
  try { json = JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error(`Failed to parse JSON: ${e.message}`); }

  const summary = summarizeShape(json);
  console.log('[shape]', JSON.stringify(summary, null, 2));

  const manifest = {
    source_url: SOURCE_URL,
    git_blob_sha: GIT_BLOB_SHA,
    sha256: sha,
    bytes: buf.length,
    fetched_at: new Date().toISOString(),
    shape: summary,
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`[manifest] ${MANIFEST}`);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

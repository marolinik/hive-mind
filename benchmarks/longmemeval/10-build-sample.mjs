#!/usr/bin/env node
// LongMemEval — build a deterministic stratified sample with structured turns.
//
// Reads the raw HF dataset (data/longmemeval_s_cleaned.json), normalizes the
// two schema variants into per-instance turn arrays, and writes a small sample
// file (data/sample-<N>.jsonl) the run script ingests. Stratified by
// question_type, proportional, deterministic (sorted by question_id) so the
// same N always yields the same sample — required for replication.
//
// Run with a large heap (the raw file is ~264 MB):
//   node --max-old-space-size=8192 10-build-sample.mjs --n 50
//
// Each output line:
//   { instance_id, conversation_id, question, expected, question_type,
//     is_abstention, n_turns, turns:[{role, content, session_id, date, session_index}] }

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const RAW_FILE = resolve(DATA_DIR, 'longmemeval_s_cleaned.json');

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}

const N = parseInt(arg('n', '50'), 10);

function normalizeTurns(q) {
  let sessions = null;
  if (Array.isArray(q.sessions) && q.sessions.length > 0) {
    sessions = q.sessions.map((s, i) => ({
      session_id: s.session_id ?? `session_${i}`,
      date: s.date,
      messages: s.messages || [],
    }));
  } else if (Array.isArray(q.haystack_sessions) && q.haystack_sessions.length > 0) {
    sessions = q.haystack_sessions.map((msgs, i) => ({
      session_id: q.haystack_session_ids?.[i] ?? `session_${i}`,
      date: q.haystack_dates?.[i],
      messages: (msgs || []).filter((m) => m && typeof m.content === 'string'),
    }));
  }
  if (!sessions) return [];
  const turns = [];
  sessions.forEach((s, si) => {
    for (const m of s.messages) {
      if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
      turns.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
        session_id: s.session_id,
        date: s.date,
        session_index: si,
      });
    }
  });
  return turns;
}

function main() {
  if (!existsSync(RAW_FILE)) {
    console.error(`Missing ${RAW_FILE} — download the dataset first (see 00-build-canonical.mjs).`);
    process.exit(2);
  }
  console.log(`[sample] parsing raw dataset (~264 MB)...`);
  const questions = JSON.parse(readFileSync(RAW_FILE, 'utf-8'));
  console.log(`[sample] ${questions.length} questions loaded`);

  // Normalize + group by type, sorted deterministically by question_id.
  const byType = new Map();
  for (const q of questions) {
    if (!q.question_id || !q.question || q.answer == null) continue;
    const turns = normalizeTurns(q);
    if (turns.length === 0) continue;
    const rec = {
      instance_id: `longmemeval_${q.question_id}`,
      conversation_id: q.question_id,
      question: q.question,
      expected: [q.answer],
      question_type: q.question_type,
      is_abstention: String(q.question_id).endsWith('_abs'),
      n_turns: turns.length,
      turns,
    };
    if (!byType.has(q.question_type)) byType.set(q.question_type, []);
    byType.get(q.question_type).push(rec);
  }
  for (const arr of byType.values()) arr.sort((a, b) => a.instance_id.localeCompare(b.instance_id));

  const totalAvail = [...byType.values()].reduce((s, a) => s + a.length, 0);
  // Proportional, deterministic quota per type. Guarantee >=1 per non-empty type.
  const sample = [];
  for (const [type, arr] of byType) {
    let quota = Math.max(1, Math.round((N * arr.length) / totalAvail));
    quota = Math.min(quota, arr.length);
    for (let i = 0; i < quota; i++) sample.push(arr[i]);
  }
  // Trim/pad to exactly N where possible (deterministic by id).
  sample.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const finalSample = sample.slice(0, N);

  const dist = {};
  for (const r of finalSample) dist[r.question_type] = (dist[r.question_type] ?? 0) + 1;

  const outFile = resolve(DATA_DIR, `sample-${finalSample.length}.jsonl`);
  writeFileSync(outFile, finalSample.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

  const avgTurns = Math.round(finalSample.reduce((s, r) => s + r.n_turns, 0) / finalSample.length);
  console.log(`[sample] wrote ${outFile}`);
  console.log(`[sample] n=${finalSample.length} | avg turns/instance=${avgTurns} | distribution:`, dist);
}

main();

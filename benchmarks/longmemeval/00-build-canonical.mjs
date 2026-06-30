#!/usr/bin/env node
// LongMemEval V1 (S-variant) canonical builder — hive-mind benchmark harness.
//
// Ported from the Waggle OS harness (build-longmemeval-canonical.ts) to a
// zero-dependency .mjs that fits the hive-mind/benchmarks convention (cf.
// benchmarks/locomo/*.mjs). Reads the raw HF dataset, normalizes the two
// known schema variants, and emits a deterministic canonical JSONL + meta.json
// with a SHA-256 dataset_version for replication checks.
//
// Source: xiaowu0162/longmemeval-cleaned on Hugging Face (Wu et al. 2024,
// arXiv:2410.10813). Download the raw file first:
//   curl -L -o data/longmemeval_s_cleaned.json \
//     https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
//
// Usage: node 00-build-canonical.mjs   (expects data/longmemeval_s_cleaned.json)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const RAW_FILE = resolve(DATA_DIR, 'longmemeval_s_cleaned.json');
const OUT_JSONL = resolve(DATA_DIR, 'longmemeval.jsonl');
const OUT_META = resolve(DATA_DIR, 'longmemeval.meta.json');

const QUESTION_TYPES = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'temporal-reasoning',
  'knowledge-update',
  'multi-session',
];

const FIELD_ORDER = [
  'instance_id', 'conversation_id', 'question', 'expected',
  'context', 'question_type', 'is_abstention',
];

// Concatenate sessions into one context string (Session N (date): role: content).
function buildContext(sessions) {
  const blocks = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const header = s.date ? `Session ${i + 1} (${s.date}):` : `Session ${i + 1}:`;
    const lines = (s.messages || []).map((m) => `${m.role}: ${m.content}`);
    blocks.push([header, ...lines].join('\n'));
  }
  return blocks.join('\n\n');
}

function serialize(inst) {
  const ordered = {};
  for (const k of FIELD_ORDER) ordered[k] = inst[k];
  return JSON.stringify(ordered);
}

function main() {
  if (!existsSync(RAW_FILE)) {
    console.error(`Raw dataset missing: ${RAW_FILE}`);
    console.error('Download it first:');
    console.error('  curl -L -o data/longmemeval_s_cleaned.json \\');
    console.error('    https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json');
    process.exit(2);
  }

  const questions = JSON.parse(readFileSync(RAW_FILE, 'utf-8'));
  if (!Array.isArray(questions)) {
    console.error('Expected a top-level JSON array.');
    process.exit(1);
  }
  console.log(`[build] loaded ${questions.length} questions`);

  const all = [];
  const skip = { missingFields: 0, noSessions: 0 };

  for (const q of questions) {
    if (!q.question_id || !q.question || q.answer === undefined || q.answer === null) {
      skip.missingFields++;
      continue;
    }
    // Normalize both schema variants.
    let sessions = null;
    if (Array.isArray(q.sessions) && q.sessions.length > 0) {
      sessions = q.sessions;
    } else if (Array.isArray(q.haystack_sessions) && q.haystack_sessions.length > 0) {
      sessions = q.haystack_sessions.map((msgs, i) => ({
        session_id: q.haystack_session_ids?.[i] ?? `session_${i}`,
        date: q.haystack_dates?.[i],
        messages: (msgs || []).filter((m) => m && typeof m.content === 'string'),
      }));
    }
    if (!sessions || sessions.length === 0) {
      skip.noSessions++;
      continue;
    }

    all.push({
      instance_id: `longmemeval_${q.question_id}`,
      conversation_id: q.question_id,
      question: q.question,
      expected: [q.answer],
      context: buildContext(sessions),
      question_type: q.question_type,
      is_abstention: String(q.question_id).endsWith('_abs'),
    });
  }

  all.sort((a, b) => a.instance_id.localeCompare(b.instance_id));

  const byType = {};
  for (const t of QUESTION_TYPES) byType[t] = 0;
  for (const i of all) byType[i.question_type] = (byType[i.question_type] ?? 0) + 1;
  const abstention = all.filter((i) => i.is_abstention).length;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const body = all.map(serialize).join('\n') + '\n';
  writeFileSync(OUT_JSONL, body, 'utf-8');
  const hash = createHash('sha256').update(body, 'utf-8').digest('hex');

  const meta = {
    dataset_version: hash,
    instance_count: all.length,
    variant: 's',
    built_at_note: 'run date stamped at commit time (no Date.now in harness)',
    source: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
    source_reference: 'Wu et al. 2024, LongMemEval (arXiv:2410.10813)',
    hf_repo: 'xiaowu0162/longmemeval-cleaned',
    distribution_by_question_type: byType,
    abstention_count: abstention,
    skip_stats: skip,
    expected_count: 500,
    count_matches_expected: all.length === 500,
  };
  writeFileSync(OUT_META, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

  console.log('[build] distribution:', byType);
  console.log(`[build] abstention: ${abstention} | skipped:`, skip);
  console.log(`[build] wrote ${OUT_JSONL} (${all.length} instances)`);
  console.log(`[build] dataset_version sha256: ${hash}`);
  if (all.length !== 500) console.warn(`[build] WARNING: expected 500, got ${all.length}`);
}

main();

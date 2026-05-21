#!/usr/bin/env node
// Phase 21 — Cell 2 (full-context oracle) with gpt-4o-mini SUBJECT
//
// Apples-to-apples re-run of cell-oracle using gpt-4o-mini as the subject
// (matches Mem0 paper protocol). Same prompt + answer format as the Qwen
// run for honest comparison; only the model identity changes.
//
// Sample: sample-cells-23-N320.jsonl (80 per category, expanded from 20).

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const SAMPLE_FILE = resolve(DATA_DIR, 'sample-cells-23-N320.jsonl');
const DATASET = resolve(DATA_DIR, 'locomo10.json');
const OUT_DIR = resolve(DATA_DIR, 'answers');
const OUT_FILE = resolve(OUT_DIR, 'cell-oracle-gpt4o.jsonl');

const SUBJECT_MODEL = 'gpt-4o-mini';

function loadEnv() {
  const envFile = resolve(__dirname, '..', '..', '.env.locomo-trio');
  if (!existsSync(envFile)) throw new Error(`.env.locomo-trio not found`);
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

function buildOracleContext(conv) {
  const sks = Object.keys(conv.conversation)
    .filter(k => /^session_\d+$/.test(k) && Array.isArray(conv.conversation[k]))
    .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10));
  const blocks = [];
  for (const sk of sks) {
    const sn = parseInt(sk.split('_')[1], 10);
    const date = conv.conversation[`${sk}_date_time`] || '';
    const header = date ? `Session ${sn} (${date}):` : `Session ${sn}:`;
    const lines = conv.conversation[sk].map(t => `${t.speaker}: ${t.text}`);
    blocks.push([header, ...lines].join('\n'));
  }
  return blocks.join('\n\n');
}

const SYSTEM_PROMPT =
  'You are answering questions about a long-running conversation between two people. ' +
  'You will be shown the full conversation history. Answer the question as concisely and ' +
  'precisely as possible. If the answer is a date, format it as in the conversation. If ' +
  'the answer cannot be determined from the conversation, say "Not stated in the conversation." ' +
  'Provide ONLY the answer — no preamble, no explanation, no quoting the question.';

async function callGpt4omini(conv, question) {
  const ctx = buildOracleContext(conv);
  const userMsg = `Conversation:\n\n${ctx}\n\n---\nQuestion: ${question}\n\nAnswer:`;
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: SUBJECT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      max_tokens: 500,
      temperature: 0,
    }),
  });
  const elapsed_ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  const msg = j.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? '',
    finish_reason: j.choices?.[0]?.finish_reason ?? null,
    usage: j.usage ?? null,
    context_chars: ctx.length,
    elapsed_ms,
  };
}

function countLines(p) {
  if (!existsSync(p)) return 0;
  if (statSync(p).size === 0) return 0;
  const txt = readFileSync(p, 'utf8');
  let n = 0;
  for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 10) n++;
  if (txt[txt.length - 1] !== '\n') n++;
  return n;
}

async function main() {
  loadEnv();
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not loaded');
  if (!existsSync(SAMPLE_FILE)) throw new Error(`sample-cells-23-N320 missing`);

  const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
  const sample = readFileSync(SAMPLE_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null;
  const total = slice ? Math.min(slice, sample.length) : sample.length;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);

  console.log(`[oracle-gpt4o] subject=${SUBJECT_MODEL} sample=${sample.length} total=${total} resume_from=${resumeFrom}`);
  const tStart = Date.now();
  let succeeded = 0, failed = 0;
  for (let i = resumeFrom; i < total; i++) {
    const it = sample[i];
    const conv = dataset[it.conv_idx];
    process.stdout.write(`  [${i + 1}/${total}] cat=${it.category_label} sid=${it.sample_id} | `);
    try {
      const r = await callGpt4omini(conv, it.question);
      const row = {
        instance_id: it.instance_id, qa_idx: i, sample_id: it.sample_id,
        conv_idx: it.conv_idx, category: it.category, category_label: it.category_label,
        question: it.question, ground_truth: it.answer, evidence: it.evidence,
        cell: 'oracle', subject_model: SUBJECT_MODEL,
        answer_content: r.content, finish_reason: r.finish_reason,
        usage: r.usage, context_chars: r.context_chars, elapsed_ms: r.elapsed_ms,
      };
      appendFileSync(OUT_FILE, JSON.stringify(row) + '\n');
      const ans = r.content.replace(/\s+/g, ' ').slice(0, 60);
      console.log(`${(r.elapsed_ms/1000).toFixed(1)}s | "${ans}"`);
      succeeded++;
    } catch (e) {
      appendFileSync(OUT_FILE, JSON.stringify({
        instance_id: it.instance_id, qa_idx: i, cell: 'oracle',
        error: String(e.message || e), elapsed_ms: 0,
      }) + '\n');
      console.log(`ERR: ${String(e.message || e).slice(0, 100)}`);
      failed++;
    }
  }
  console.log(`[done] ${((Date.now() - tStart)/1000).toFixed(1)}s | ok=${succeeded} fail=${failed}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

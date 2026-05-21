#!/usr/bin/env node
// Phase 11 — Cell 2 (full-context oracle) — Qwen subject answers each
// LoCoMo question with the ENTIRE conversation in-context. This is the
// substrate-quality ceiling: any retrieval-cell number that approaches
// this is "as good as having the whole conv" for that question.
//
// Subject: qwen3.6-35b-a3b on DashScope (OpenAI-compat), thinking=ON,
// max_tokens=16000 (total: reasoning + content), temperature=0.
// Per the user's 2026-05-08 decision, thinking-ON is a methodology
// delta vs Stage 3 v6 (which locked thinking=off) — to be disclosed
// in the writeup.
//
// Append-only JSONL with resume-from-line-count for crash safety.

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const SAMPLE_FILE = resolve(DATA_DIR, 'sample-cells-23.jsonl');
const DATASET = resolve(DATA_DIR, 'locomo10.json');
const OUT_DIR = resolve(DATA_DIR, 'answers');
const OUT_FILE = resolve(OUT_DIR, 'cell-oracle.jsonl');

const DASHSCOPE_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const SUBJECT_MODEL = 'qwen3.6-35b-a3b';

function loadEnv() {
  // Manually parse .env.locomo-trio (don't depend on dotenv being installed)
  const envFile = resolve(__dirname, '..', '..', '.env.locomo-trio');
  if (!existsSync(envFile)) throw new Error(`.env.locomo-trio not found at ${envFile}`);
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

async function callQwen(conv, question) {
  const ctx = buildOracleContext(conv);
  const userMsg = `Conversation:\n\n${ctx}\n\n---\nQuestion: ${question}\n\nAnswer:`;
  const body = {
    model: SUBJECT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    max_tokens: 16000,
    temperature: 0,
    enable_thinking: true,
  };
  const t0 = Date.now();
  const res = await fetch(`${DASHSCOPE_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const elapsed_ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  const msg = j.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? '',
    reasoning_content: msg.reasoning_content ?? '',
    finish_reason: j.choices?.[0]?.finish_reason ?? null,
    usage: j.usage ?? null,
    context_chars: ctx.length,
    elapsed_ms,
  };
}

function countLines(path) {
  if (!existsSync(path)) return 0;
  const sz = statSync(path).size;
  if (sz === 0) return 0;
  const txt = readFileSync(path, 'utf8');
  let n = 0;
  for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 10) n++;
  if (txt[txt.length - 1] !== '\n') n++;
  return n;
}

async function main() {
  loadEnv();
  if (!process.env.DASHSCOPE_API_KEY) throw new Error('DASHSCOPE_API_KEY not loaded');
  if (!existsSync(SAMPLE_FILE)) throw new Error(`Run 10-build-sample.mjs first`);
  if (!existsSync(DATASET)) throw new Error(`Dataset missing`);

  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null;
  const dryRun = process.argv.includes('--dry-run');

  const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
  const sample = readFileSync(SAMPLE_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const total = slice ? Math.min(slice, sample.length) : sample.length;

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);

  console.log(`[oracle] subject=${SUBJECT_MODEL} thinking=ON temp=0 max_tokens=16000`);
  console.log(`         sample=${sample.length} total=${total} resume_from=${resumeFrom} dryRun=${dryRun}`);

  const tStart = Date.now();
  let succeeded = 0, failed = 0, totalUsd = 0;
  for (let i = resumeFrom; i < total; i++) {
    const it = sample[i];
    const conv = dataset[it.conv_idx];
    const ctxChars = buildOracleContext(conv).length;
    const ctxKtok = (ctxChars / 4 / 1000).toFixed(1);
    process.stdout.write(`  [${i + 1}/${total}] cat=${it.category_label} ctx≈${ctxKtok}K tok | sid=${it.sample_id} | `);
    if (dryRun) { console.log('DRY'); continue; }
    try {
      const r = await callQwen(conv, it.question);
      const row = {
        instance_id: it.instance_id,
        qa_idx: i,
        sample_id: it.sample_id,
        conv_idx: it.conv_idx,
        category: it.category,
        category_label: it.category_label,
        question: it.question,
        ground_truth: it.answer,
        evidence: it.evidence,
        cell: 'oracle',
        subject_model: SUBJECT_MODEL,
        subject_thinking: true,
        answer_content: r.content,
        answer_reasoning: r.reasoning_content,
        finish_reason: r.finish_reason,
        usage: r.usage,
        context_chars: r.context_chars,
        elapsed_ms: r.elapsed_ms,
      };
      appendFileSync(OUT_FILE, JSON.stringify(row) + '\n');
      const ans = r.content.replace(/\s+/g, ' ').slice(0, 60);
      const usd = r.usage ? (r.usage.total_tokens || 0) * 0.000001 : 0; // rough estimate
      totalUsd += usd;
      console.log(`${(r.elapsed_ms / 1000).toFixed(1)}s | "${ans}"`);
      succeeded++;
    } catch (e) {
      const row = {
        instance_id: it.instance_id, qa_idx: i, cell: 'oracle',
        error: String(e.message || e), elapsed_ms: 0,
      };
      appendFileSync(OUT_FILE, JSON.stringify(row) + '\n');
      console.log(`ERR: ${String(e.message || e).slice(0, 100)}`);
      failed++;
    }
  }
  const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`[done] ${totalSec}s | ok=${succeeded} fail=${failed} | output=${OUT_FILE}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

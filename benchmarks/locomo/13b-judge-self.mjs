#!/usr/bin/env node
// Phase 13b — Self-judge scorer (Qwen judges Qwen)
//
// Same answers from cell-oracle + cell-retrieval, but evaluated by Qwen
// (the same model family that produced them). Self-judge is the methodology
// Mem0 used for their published 91.6% — running it on our outputs gives a
// number directly comparable to that headline. Per the +27.35pp methodology
// gap finding, self-judge is expected to be ~+25-30pp higher than trio-strict
// on the same answers.
//
// Why this is informative: replicates the bias gap empirically on OUR
// system, anchors our trio-strict number to a self-judge equivalent for
// cross-paper comparison.

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const ANS_DIR = resolve(DATA_DIR, 'answers');
const OUT_DIR = resolve(DATA_DIR, 'judgments');
const OUT_FILE = resolve(OUT_DIR, 'self-judgments.jsonl');

const DASHSCOPE_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const JUDGE_MODEL = 'qwen3.6-35b-a3b'; // SAME as subject — that's the point

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

function buildJudgePrompt(question, reference, modelAnswer) {
  return `You are evaluating a model's answer to a question about a long conversation.

Question: ${question}

Reference answer: ${reference}

Model's answer: ${modelAnswer}

Decide: is the model's answer correct? It is correct if it matches the reference's
key facts (exact wording NOT required, paraphrase OK). It is incorrect if it
hallucinates, refuses when the reference is answerable, or gets specifics wrong
(wrong name, wrong date, wrong place).

Respond with EXACTLY one of:
CORRECT — <one short sentence why>
INCORRECT — <one short sentence why>`;
}

function parseVerdict(text) {
  const m = String(text || '').match(/^\s*(CORRECT|INCORRECT)\b/im);
  if (m) return { verdict: m[1].toUpperCase() === 'CORRECT' ? 1 : 0, parsed: true, raw: text };
  const head = String(text || '').slice(0, 200).toUpperCase();
  if (/\bCORRECT\b/.test(head) && !/\bINCORRECT\b/.test(head)) return { verdict: 1, parsed: true, raw: text };
  if (/\bINCORRECT\b/.test(head)) return { verdict: 0, parsed: true, raw: text };
  return { verdict: null, parsed: false, raw: text };
}

async function judgeQwen(prompt) {
  const t0 = Date.now();
  const res = await fetch(`${DASHSCOPE_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      // For judge prompts, thinking-OFF is the right call — judges don't need
      // to "reason aloud" to render a binary verdict, and thinking-on burns
      // tokens unnecessarily. Keeps the methodology fair to Mem0's self-judge
      // which presumably wasn't reasoning-augmented either.
      max_tokens: 200,
      temperature: 0,
      enable_thinking: false,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`DashScope ${res.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  const text = j.choices?.[0]?.message?.content || '';
  return { ...parseVerdict(text), elapsed_ms: Date.now() - t0, model: JUDGE_MODEL };
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

function loadAnswers() {
  const rows = [];
  for (const cellName of ['oracle', 'retrieval']) {
    const p = resolve(ANS_DIR, `cell-${cellName}.jsonl`);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, 'utf8').trim().split('\n')) {
      const r = JSON.parse(l);
      if (!r.error) rows.push(r);
    }
  }
  return rows;
}

async function main() {
  loadEnv();
  if (!process.env.DASHSCOPE_API_KEY) throw new Error('DASHSCOPE_API_KEY not loaded');
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const rows = loadAnswers();
  if (rows.length === 0) throw new Error('No answers — run cell harnesses first');

  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null;
  const total = slice ? Math.min(slice, rows.length) : rows.length;
  const resumeFrom = countLines(OUT_FILE);

  console.log(`[self-judge] ${rows.length} answers loaded; processing ${total - resumeFrom} (resume_from=${resumeFrom})`);
  console.log(`             judge: ${JUDGE_MODEL} (same as subject)`);

  const tStart = Date.now();
  let n = 0, correct = 0, parseFailures = 0;
  for (let i = resumeFrom; i < total; i++) {
    const r = rows[i];
    const prompt = buildJudgePrompt(r.question, r.ground_truth, r.answer_content);
    process.stdout.write(`  [${i + 1}/${total}] cell=${r.cell} cat=${r.category_label} | `);
    let v;
    try {
      v = await judgeQwen(prompt);
    } catch (e) {
      v = { error: String(e.message || e), verdict: null, parsed: false };
    }
    if (v.verdict === 1) correct++;
    if (v.verdict === null) parseFailures++;
    const row = {
      idx: i, instance_id: r.instance_id, cell: r.cell,
      category: r.category, category_label: r.category_label,
      question: r.question, ground_truth: r.ground_truth, answer_content: r.answer_content,
      judge: v, verdict: v.verdict,
    };
    appendFileSync(OUT_FILE, JSON.stringify(row) + '\n');
    n++;
    const tag = v.verdict === 1 ? 'CORRECT' : (v.verdict === 0 ? 'INCORRECT' : 'PARSE-FAIL');
    console.log(`${(v.elapsed_ms/1000).toFixed(1)}s → ${tag}`);
  }
  const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`[done] ${totalSec}s | judged=${n} correct=${correct} parse-failures=${parseFailures}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

#!/usr/bin/env node
// Phase 13c — Mem0-protocol judge (gpt-4o-mini, verbatim Mem0 prompt)
//
// Replicates Mem0's evaluation methodology exactly so we can produce a number
// directly comparable to Mem0 paper Table 1/2 (66.88% / 68.44% overall J).
//
// Source: github.com/mem0ai/mem0/evaluation/metrics/llm_judge.py
// Prompt + parameters fetched verbatim 2026-05-08; see MEM0-METHODOLOGY.md
// in the project root for the exact code reference.
//
// Differences vs our trio-strict and self-judge:
//   • Judge: gpt-4o-mini (not Opus/GPT-5.5/MiniMax/Qwen)
//   • Prompt: "be generous with your grading" — lenient (Mem0's verbatim)
//   • Single judge, binary 0/1, JSON output, temperature=0
//   • Same answers from cell-oracle.jsonl + cell-retrieval.jsonl
//
// Output: data/judgments/mem0-judgments.jsonl

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const ANS_DIR = resolve(DATA_DIR, 'answers');
const OUT_DIR = resolve(DATA_DIR, 'judgments');
const OUT_FILE = resolve(OUT_DIR, 'mem0-judgments.jsonl');

const JUDGE_MODEL = 'gpt-4o-mini';

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

// Verbatim from mem0ai/mem0/evaluation/metrics/llm_judge.py — DO NOT alter
// without disclosing the deviation in the writeup. The "be generous" wording
// is load-bearing methodologically.
const ACCURACY_PROMPT = `
Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a 'gold' (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {generated_answer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
`;

async function judgeMem0(question, gold, generated) {
  const prompt = ACCURACY_PROMPT
    .replace('{question}', question)
    .replace('{gold_answer}', gold)
    .replace('{generated_answer}', generated);

  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.0,
    }),
  });
  const elapsed_ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  const content = j.choices?.[0]?.message?.content || '{}';
  let parsed = null;
  let verdict = null;
  try {
    parsed = JSON.parse(content);
    if (parsed.label === 'CORRECT') verdict = 1;
    else if (parsed.label === 'WRONG') verdict = 0;
  } catch { /* parse fail */ }
  return { verdict, parsed, raw: content, elapsed_ms, model: JUDGE_MODEL };
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
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not loaded');
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const rows = loadAnswers();
  if (rows.length === 0) throw new Error('No answers — run cell harnesses first');

  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null;
  const total = slice ? Math.min(slice, rows.length) : rows.length;
  const resumeFrom = countLines(OUT_FILE);

  console.log(`[mem0-judge] ${rows.length} answers loaded; processing ${total - resumeFrom} (resume_from=${resumeFrom})`);
  console.log(`             judge: ${JUDGE_MODEL} | prompt: Mem0 verbatim ("be generous") | binary 0/1`);

  const tStart = Date.now();
  let n = 0, correct = 0, parseFailures = 0;
  for (let i = resumeFrom; i < total; i++) {
    const r = rows[i];
    process.stdout.write(`  [${i + 1}/${total}] cell=${r.cell} cat=${r.category_label} | `);
    let v;
    try {
      v = await judgeMem0(r.question, r.ground_truth, r.answer_content);
    } catch (e) {
      v = { error: String(e.message || e), verdict: null };
    }
    if (v.verdict === 1) correct++;
    if (v.verdict === null) parseFailures++;
    appendFileSync(OUT_FILE, JSON.stringify({
      idx: i, instance_id: r.instance_id, cell: r.cell,
      category: r.category, category_label: r.category_label,
      question: r.question, ground_truth: r.ground_truth, answer_content: r.answer_content,
      judge: v, verdict: v.verdict,
    }) + '\n');
    n++;
    const tag = v.verdict === 1 ? 'CORRECT' : (v.verdict === 0 ? 'WRONG' : 'PARSE-FAIL');
    console.log(`${(v.elapsed_ms/1000).toFixed(1)}s → ${tag}`);
  }
  const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`[done] ${totalSec}s | judged=${n} correct=${correct} parse-failures=${parseFailures}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

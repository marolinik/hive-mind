#!/usr/bin/env node
// Phase 23 — Mem0-protocol judge for gpt-4o-mini-subject answers
//
// Same verbatim Mem0 prompt + gpt-4o-mini judge as 13c-judge-mem0, but reads
// cell-oracle-gpt4o.jsonl + cell-retrieval-gpt4o.jsonl (the gpt-4o-mini
// SUBJECT outputs from N=320 sample). Writes to mem0-judgments-gpt4o.jsonl.

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const ANS_DIR = resolve(DATA_DIR, 'answers');
const OUT_DIR = resolve(DATA_DIR, 'judgments');
const OUT_FILE = resolve(OUT_DIR, 'mem0-judgments-gpt4o.jsonl');

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

async function judge(question, gold, generated) {
  const prompt = ACCURACY_PROMPT
    .replace('{question}', question)
    .replace('{gold_answer}', gold)
    .replace('{generated_answer}', generated);
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
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
  let verdict = null;
  try {
    const parsed = JSON.parse(content);
    if (parsed.label === 'CORRECT') verdict = 1;
    else if (parsed.label === 'WRONG') verdict = 0;
  } catch { /* parse fail */ }
  return { verdict, raw: content, elapsed_ms, model: JUDGE_MODEL };
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

function loadAnswers(cellFilter) {
  const rows = [];
  const cells = cellFilter ? [cellFilter] : ['oracle', 'retrieval'];
  for (const cellName of cells) {
    const p = resolve(ANS_DIR, `cell-${cellName}-gpt4o.jsonl`);
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

  const cellArg = process.argv.find(a => a.startsWith('--cell='));
  const cellFilter = cellArg ? cellArg.split('=')[1] : null; // 'oracle' | 'retrieval' | null
  const outFile = cellFilter ? resolve(OUT_DIR, `mem0-judgments-gpt4o-${cellFilter}.jsonl`) : OUT_FILE;

  const rows = loadAnswers(cellFilter);
  if (rows.length === 0) throw new Error('No gpt-4o-mini answers — run 21+22 first');

  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null;
  const total = slice ? Math.min(slice, rows.length) : rows.length;
  const resumeFrom = countLines(outFile);

  console.log(`[mem0-judge-gpt4o] cell=${cellFilter ?? 'all'} ${rows.length} answers loaded; processing ${total - resumeFrom} (resume_from=${resumeFrom}) → ${outFile}`);
  const tStart = Date.now();
  let n = 0, correct = 0, parseFailures = 0;
  for (let i = resumeFrom; i < total; i++) {
    const r = rows[i];
    process.stdout.write(`  [${i + 1}/${total}] cell=${r.cell} cat=${r.category_label} | `);
    let v;
    try { v = await judge(r.question, r.ground_truth, r.answer_content); }
    catch (e) { v = { error: String(e.message || e), verdict: null }; }
    if (v.verdict === 1) correct++;
    if (v.verdict === null) parseFailures++;
    appendFileSync(outFile, JSON.stringify({
      idx: i, instance_id: r.instance_id, cell: r.cell,
      category: r.category, category_label: r.category_label,
      question: r.question, ground_truth: r.ground_truth, answer_content: r.answer_content,
      judge: v, verdict: v.verdict,
    }) + '\n');
    n++;
    const tag = v.verdict === 1 ? 'CORRECT' : (v.verdict === 0 ? 'WRONG' : 'PARSE-FAIL');
    console.log(`${(v.elapsed_ms/1000).toFixed(1)}s → ${tag}`);
  }
  console.log(`[done] ${((Date.now() - tStart)/1000).toFixed(1)}s | judged=${n} correct=${correct} parse-failures=${parseFailures}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

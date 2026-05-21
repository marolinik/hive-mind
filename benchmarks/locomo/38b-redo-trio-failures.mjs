#!/usr/bin/env node
// Phase 38b — Redo trio judge for parse-failure rows only.
//
// Reads the existing trio-judgments-v5-retrieval.jsonl (320 rows, of which
// 63 had parse failures due to MiniMax / GPT reasoning-token overflow), and
// re-judges ONLY those 63 rows using the fixed 38-judge-trio-v5.mjs
// (bumped max_tokens: Opus 200->500, GPT 200->500, MiniMax 800->3000;
// parser now accepts INCORRECT as a WRONG synonym).
//
// Output: trio-judgments-v5-retrieval.v2.jsonl
//   - 257 clean rows from v1 (unchanged)
//   - 63 re-judged rows (verdicts may differ)
//
// Cost estimate: 63 rows × 3 judges = ~$2-3 (vs $12-14 for full re-run).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const ANS_FILE = resolve(DATA_DIR, 'answers', 'cell-retrieval-v5-claude.jsonl');
const IN_FILE = resolve(DATA_DIR, 'judgments', 'trio-judgments-v5-retrieval.jsonl');
const OUT_FILE = resolve(DATA_DIR, 'judgments', 'trio-judgments-v5-retrieval.v2.jsonl');

const ANTHROPIC_MODEL = 'claude-opus-4-7';
const OPENAI_MODEL = 'gpt-5.5-2026-04-23';
const MINIMAX_MODEL = 'MiniMax-M2.7';

function loadEnv() {
  const envFile = resolve(__dirname, '..', '..', '.env.locomo-trio');
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

Just return the label CORRECT or WRONG in a json format with the key as "label".`;

function buildPrompt(question, reference, modelAnswer) {
  return ACCURACY_PROMPT
    .replace('{question}', question || '')
    .replace('{gold_answer}', reference || '')
    .replace('{generated_answer}', modelAnswer || '');
}

// Improved parser — accepts INCORRECT as WRONG.
function parseVerdict(text) {
  const raw = String(text || '');
  const jsonMatch = raw.match(/\{\s*"label"\s*:\s*"(CORRECT|WRONG|INCORRECT)"\s*\}/i);
  if (jsonMatch) {
    return { verdict: jsonMatch[1].toUpperCase() === 'CORRECT' ? 1 : 0, parsed: true, raw };
  }
  const tail = raw.slice(-400).toUpperCase();
  const hasCorrect = /\bCORRECT\b/.test(tail);
  const hasWrong = /\bWRONG\b/.test(tail);
  const hasIncorrect = /\bINCORRECT\b/.test(tail);
  if (hasIncorrect && !hasWrong) return { verdict: 0, parsed: true, raw };
  if (hasWrong) return { verdict: 0, parsed: true, raw };
  if (hasCorrect) return { verdict: 1, parsed: true, raw };
  return { verdict: null, parsed: false, raw };
}

async function judgeAnthropic(prompt) {
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  const text = (j.content || []).map(b => b.text || '').join('');
  return { ...parseVerdict(text), elapsed_ms: Date.now() - t0, model: ANTHROPIC_MODEL };
}

async function judgeOpenAI(prompt) {
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL, max_completion_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  const text = j.choices?.[0]?.message?.content || '';
  return { ...parseVerdict(text), elapsed_ms: Date.now() - t0, model: OPENAI_MODEL };
}

async function judgeMiniMax(prompt) {
  const t0 = Date.now();
  const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MINIMAX_MODEL, max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`MiniMax ${res.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  const text = j.choices?.[0]?.message?.content || '';
  return { ...parseVerdict(text), elapsed_ms: Date.now() - t0, model: MINIMAX_MODEL };
}

async function rejudgeOne(row, ansById) {
  const ans = ansById.get(row.instance_id);
  if (!ans) throw new Error(`answer not found for ${row.instance_id}`);
  const prompt = buildPrompt(ans.question, ans.ground_truth, ans.answer_content);

  // Only re-judge the failed judges; keep the parsed ones as-is.
  const reJudges = {};
  const tasks = [];
  for (const j of ['opus', 'gpt', 'mm']) {
    if (row.judges[j].parsed === false) {
      const fn = { opus: judgeAnthropic, gpt: judgeOpenAI, mm: judgeMiniMax }[j];
      tasks.push(fn(prompt).then(r => ({ j, r })).catch(e => ({ j, r: { error: String(e.message || e), verdict: null, parsed: false } })));
    } else {
      reJudges[j] = row.judges[j];
    }
  }
  const results = await Promise.all(tasks);
  for (const { j, r } of results) reJudges[j] = r;

  const verdicts = [reJudges.opus.verdict, reJudges.gpt.verdict, reJudges.mm.verdict];
  const allParsed = verdicts.every(v => v === 0 || v === 1);
  const trioStrict = allParsed && verdicts.every(v => v === 1) ? 1 : (allParsed ? 0 : null);
  const trioMajority = allParsed ? (verdicts.filter(v => v === 1).length >= 2 ? 1 : 0) : null;

  return {
    ...row,
    judges: reJudges,
    verdicts: { opus: reJudges.opus.verdict, gpt: reJudges.gpt.verdict, mm: reJudges.mm.verdict },
    trio_strict: trioStrict,
    trio_majority: trioMajority,
    all_parsed: allParsed,
    rejudge_pass: true,
  };
}

async function main() {
  loadEnv();
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MINIMAX_API_KEY']) {
    if (!process.env[k]) throw new Error(`${k} not loaded`);
  }

  // Load v1 trio output
  if (!existsSync(IN_FILE)) throw new Error(`${IN_FILE} missing`);
  const v1 = readFileSync(IN_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));

  // Load v5 answers (indexed by instance_id for re-prompting)
  const ans = readFileSync(ANS_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const ansById = new Map(ans.map(a => [a.instance_id, a]));

  const failures = v1.filter(r => !r.all_parsed);
  console.log(`[redo] v1 has ${v1.length} rows; ${failures.length} have parse failures`);
  console.log(`       judges to redo per-row: ${failures.map(r => ['opus','gpt','mm'].filter(j => r.judges[j].parsed === false).length).reduce((a,b)=>a+b, 0)} judge calls total`);
  console.log(`       est cost: ~$${(failures.length * 0.04).toFixed(2)} (vs ~$13 for full re-run)`);

  const out = [];
  let n = 0;
  for (const row of v1) {
    if (row.all_parsed) {
      out.push(row);
      continue;
    }
    n++;
    process.stdout.write(`  [${n}/${failures.length}] ${row.instance_id} cat=${row.category_label} | `);
    const t0 = Date.now();
    const rejudged = await rejudgeOne(row, ansById);
    out.push(rejudged);
    const tag = rejudged.trio_strict === 1 ? 'CORRECT' : (rejudged.trio_strict === 0 ? 'INCORRECT' : 'STILL-FAIL');
    console.log(`${((Date.now()-t0)/1000).toFixed(1)}s | O=${rejudged.verdicts.opus ?? '?'} G=${rejudged.verdicts.gpt ?? '?'} M=${rejudged.verdicts.mm ?? '?'} → ${tag}`);
  }

  // Write merged v2 output
  if (!existsSync(dirname(OUT_FILE))) mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, out.map(r => JSON.stringify(r)).join('\n') + '\n');

  // Aggregate
  const trioCorrect = out.filter(r => r.trio_strict === 1).length;
  const trioMaj = out.filter(r => r.trio_majority === 1).length;
  const stillFail = out.filter(r => !r.all_parsed).length;
  console.log('');
  console.log(`[v2 done] ${out.length} rows written to ${OUT_FILE}`);
  console.log(`          trio-strict   : ${trioCorrect}/${out.length} = ${(100*trioCorrect/out.length).toFixed(1)}%`);
  console.log(`          trio-majority : ${trioMaj}/${out.length} = ${(100*trioMaj/out.length).toFixed(1)}%`);
  console.log(`          still parse-fail: ${stillFail}/${failures.length} (down from ${failures.length})`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

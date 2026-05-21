#!/usr/bin/env node
// Phase 38 — Trio-strict judge for v5 retrieval (Opus 4.7 subject).
//
// Re-judges the existing v5 answer set (data/answers/cell-retrieval-v5-claude.jsonl,
// N=320) with three independent-family judges:
//   - Anthropic Opus 4.7  (claude-opus-4-7)
//   - OpenAI GPT-5.5      (gpt-5.5-2026-04-23)
//   - MiniMax M2.7        (MiniMax-M2.7)
//
// Trio-strict verdict = AND of the three (CORRECT only when ALL three say
// CORRECT). Conservative by design — eliminates single-family inflation.
//
// IMPORTANT: This script uses the SAME Mem0 verbatim "be generous" accuracy
// prompt as 37-judge-claude-v5.mjs (the v5 self-judge). The label vocabulary
// is CORRECT/WRONG (not CORRECT/INCORRECT) — that's the Mem0 paper protocol.
// Apples-to-apples comparability vs the published 73.1% v5 self-judge number.
//
// Output JSONL: one row per qa with verdicts from all three judges + the
// trio-strict aggregate + the trio-majority aggregate + raw vote vector.
//
// Resume-safe: re-running picks up from existing line count.
// Usage:
//   node 38-judge-trio-v5.mjs                  # full N=320
//   node 38-judge-trio-v5.mjs --slice=2        # smoke test on first 2
//   node 38-judge-trio-v5.mjs --slice=10       # quick spot-check

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const ANS_FILE = resolve(DATA_DIR, 'answers', 'cell-retrieval-v5-claude.jsonl');
const OUT_DIR = resolve(DATA_DIR, 'judgments');
const OUT_FILE = resolve(OUT_DIR, 'trio-judgments-v5-retrieval.jsonl');

const ANTHROPIC_MODEL = 'claude-opus-4-7';
const OPENAI_MODEL = 'gpt-5.5-2026-04-23';
const MINIMAX_MODEL = 'MiniMax-M2.7';

function loadEnv() {
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

// Mem0 verbatim "be generous" prompt — same wording as 37-judge-claude-v5.mjs.
// Returns a JSON object with label: "CORRECT" | "WRONG".
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

// Parse for the JSON label OR fallback to scanning for CORRECT/WRONG.
function parseVerdict(text) {
  const raw = String(text || '');

  // Preferred path: JSON with "label" field
  const jsonMatch = raw.match(/\{\s*"label"\s*:\s*"(CORRECT|WRONG)"\s*\}/i);
  if (jsonMatch) {
    return { verdict: jsonMatch[1].toUpperCase() === 'CORRECT' ? 1 : 0, parsed: true, raw };
  }

  // Fallback: scan for the literal word. Mem0 prompt asks for explanation +
  // label, so we look at the END of the response where the label should sit.
  const tail = raw.slice(-400).toUpperCase();
  const hasCorrect = /\bCORRECT\b/.test(tail);
  const hasWrong = /\bWRONG\b/.test(tail);
  if (hasCorrect && !hasWrong) return { verdict: 1, parsed: true, raw };
  if (hasWrong && !hasCorrect) return { verdict: 0, parsed: true, raw };
  // Both present or neither — model violated the prompt, mark unparsed.
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
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
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
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_completion_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
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
    headers: {
      'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      max_tokens: 800,  // M2.7 emits reasoning tokens — give headroom
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`MiniMax ${res.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  const text = j.choices?.[0]?.message?.content || '';
  return { ...parseVerdict(text), elapsed_ms: Date.now() - t0, model: MINIMAX_MODEL };
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

function loadV5Answers() {
  if (!existsSync(ANS_FILE)) throw new Error(`${ANS_FILE} missing — run 36-cell-retrieval-v5-claude.mjs first`);
  const rows = [];
  for (const line of readFileSync(ANS_FILE, 'utf8').trim().split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.error) continue;
    rows.push(r);
  }
  return rows;
}

async function main() {
  loadEnv();
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MINIMAX_API_KEY']) {
    if (!process.env[k]) throw new Error(`${k} not loaded`);
  }
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const rows = loadV5Answers();
  if (rows.length === 0) throw new Error('No v5 answers found — run 36-cell-retrieval-v5-claude.mjs first');

  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null;
  const total = slice ? Math.min(slice, rows.length) : rows.length;
  const resumeFrom = countLines(OUT_FILE);

  console.log(`[trio-v5] ${rows.length} v5 answers loaded; processing ${total - resumeFrom} (resume_from=${resumeFrom}, slice=${slice ?? 'all'})`);
  console.log(`          judges: ${ANTHROPIC_MODEL} + ${OPENAI_MODEL} + ${MINIMAX_MODEL}`);
  console.log(`          prompt: Mem0 verbatim "be generous" (matches 37-judge-claude-v5 self-judge)`);
  console.log(`          output: ${OUT_FILE}`);

  const tStart = Date.now();
  let n = 0, trioCorrect = 0, trioMajCorrect = 0, parseFailures = 0;
  // Per-judge correctness for diagnostic / agreement analysis
  let opusCorrect = 0, gptCorrect = 0, mmCorrect = 0;

  for (let i = resumeFrom; i < total; i++) {
    const r = rows[i];
    const prompt = buildPrompt(r.question, r.ground_truth, r.answer_content);

    process.stdout.write(`  [${i + 1}/${total}] cat=${r.category_label || r.category} | `);
    const t0 = Date.now();
    let opus, gpt, mm;
    try {
      [opus, gpt, mm] = await Promise.all([
        judgeAnthropic(prompt).catch(e => ({ error: String(e.message || e), verdict: null, parsed: false })),
        judgeOpenAI(prompt).catch(e => ({ error: String(e.message || e), verdict: null, parsed: false })),
        judgeMiniMax(prompt).catch(e => ({ error: String(e.message || e), verdict: null, parsed: false })),
      ]);
    } catch (e) {
      console.log(`PROMISE-ALL ERR: ${e.message}`);
      continue;
    }

    if (opus.verdict === 1) opusCorrect++;
    if (gpt.verdict === 1) gptCorrect++;
    if (mm.verdict === 1) mmCorrect++;

    const verdicts = [opus.verdict, gpt.verdict, mm.verdict];
    const allParsed = verdicts.every(v => v === 0 || v === 1);
    const trioStrict = allParsed && verdicts.every(v => v === 1) ? 1 : (allParsed ? 0 : null);
    const trioMajority = allParsed ? (verdicts.filter(v => v === 1).length >= 2 ? 1 : 0) : null;

    if (trioStrict === 1) trioCorrect++;
    if (trioMajority === 1) trioMajCorrect++;
    if (!allParsed) parseFailures++;

    const row = {
      idx: i,
      instance_id: r.instance_id,
      sample_id: r.sample_id,
      conv_idx: r.conv_idx,
      workspace: r.workspace,
      category: r.category,
      category_label: r.category_label,
      question: r.question,
      ground_truth: r.ground_truth,
      answer_content: r.answer_content,
      retrieved_count: r.retrieved_count,
      judges: { opus, gpt, mm },
      verdicts: { opus: opus.verdict, gpt: gpt.verdict, mm: mm.verdict },
      trio_strict: trioStrict,
      trio_majority: trioMajority,
      all_parsed: allParsed,
      elapsed_ms: Date.now() - t0,
    };
    appendFileSync(OUT_FILE, JSON.stringify(row) + '\n');
    n++;
    const tag = trioStrict === 1 ? 'CORRECT' : (trioStrict === 0 ? 'INCORRECT' : 'PARSE-FAIL');
    console.log(`${(row.elapsed_ms/1000).toFixed(1)}s | O=${opus.verdict ?? '?'} G=${gpt.verdict ?? '?'} M=${mm.verdict ?? '?'} → ${tag}`);
  }

  const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log('');
  console.log(`[done] ${totalSec}s | judged=${n}`);
  console.log(`       per-judge correct: O=${opusCorrect} G=${gptCorrect} M=${mmCorrect}`);
  console.log(`       trio-strict correct = ${trioCorrect} / ${n} (${n ? (100 * trioCorrect / n).toFixed(1) : '0'}%)`);
  console.log(`       trio-majority correct = ${trioMajCorrect} / ${n} (${n ? (100 * trioMajCorrect / n).toFixed(1) : '0'}%)`);
  console.log(`       parse failures = ${parseFailures}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

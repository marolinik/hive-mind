#!/usr/bin/env node
// Phase 13 — Trio-strict judge scorer
//
// For every (cell, qa) row in cell-oracle.jsonl + cell-retrieval.jsonl,
// poll three independent-family judges (Opus 4.7, GPT-5.5, MiniMax-M2.7)
// with the same binary-correctness prompt. Trio-strict verdict = AND of
// the three (correct only when ALL three say correct). Conservative by
// design — reduces single-family inflation per the +27.35pp methodology
// gap finding.
//
// Output JSONL: one row per (cell, qa) with verdicts from all three judges
// + the trio-strict aggregate + Cohen's kappa-relevant raw votes for later
// pair-wise agreement computation.
//
// Resume-safe: re-running picks up from line count.

import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const ANS_DIR = resolve(DATA_DIR, 'answers');
const OUT_DIR = resolve(DATA_DIR, 'judgments');
const OUT_FILE = resolve(OUT_DIR, 'trio-judgments.jsonl');

const ANTHROPIC_MODEL = 'claude-opus-4-7';
const OPENAI_MODEL = 'gpt-5.5-2026-04-23';
const MINIMAX_MODEL = 'MiniMax-M2.7';

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

// Single binary-correctness judge prompt — same wording for all three judges,
// same wording for self-judge. Mirrors the Stage 3 v6 judge contract: assess
// whether the model's answer matches the reference, allowing minor paraphrase
// but rejecting hallucination, refusal-when-answerable, or wrong specifics.
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
  // Fallback: scan first 200 chars for the words
  const head = String(text || '').slice(0, 200).toUpperCase();
  if (/\bCORRECT\b/.test(head) && !/\bINCORRECT\b/.test(head)) return { verdict: 1, parsed: true, raw: text };
  if (/\bINCORRECT\b/.test(head)) return { verdict: 0, parsed: true, raw: text };
  return { verdict: null, parsed: false, raw: text };
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
      max_tokens: 800,  // M2.7 generates reasoning tokens too — give headroom
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

function loadAnswers() {
  const rows = [];
  for (const cellName of ['oracle', 'retrieval']) {
    const p = resolve(ANS_DIR, `cell-${cellName}.jsonl`);
    if (!existsSync(p)) {
      console.warn(`[warn] ${p} missing — skipping cell ${cellName}`);
      continue;
    }
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    for (const l of lines) {
      const r = JSON.parse(l);
      if (r.error) continue;
      rows.push(r);
    }
  }
  return rows;
}

async function main() {
  loadEnv();
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MINIMAX_API_KEY']) {
    if (!process.env[k]) throw new Error(`${k} not loaded`);
  }
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const rows = loadAnswers();
  if (rows.length === 0) throw new Error('No answers found — run cell harnesses first');

  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null;
  const total = slice ? Math.min(slice, rows.length) : rows.length;
  const resumeFrom = countLines(OUT_FILE);

  console.log(`[trio] ${rows.length} answers loaded; processing ${total - resumeFrom} (resume_from=${resumeFrom}, slice=${slice ?? 'all'})`);
  console.log(`       judges: ${ANTHROPIC_MODEL} + ${OPENAI_MODEL} + ${MINIMAX_MODEL}`);

  const tStart = Date.now();
  let n = 0, trioCorrect = 0, parseFailures = 0;
  for (let i = resumeFrom; i < total; i++) {
    const r = rows[i];
    const prompt = buildJudgePrompt(r.question, r.ground_truth, r.answer_content);

    process.stdout.write(`  [${i + 1}/${total}] cell=${r.cell} cat=${r.category_label} | `);
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

    const verdicts = [opus.verdict, gpt.verdict, mm.verdict];
    const allParsed = verdicts.every(v => v === 0 || v === 1);
    const trioStrict = allParsed && verdicts.every(v => v === 1) ? 1 : (allParsed ? 0 : null);
    const trioMajority = allParsed ? (verdicts.filter(v => v === 1).length >= 2 ? 1 : 0) : null;

    if (trioStrict === 1) trioCorrect++;
    if (!allParsed) parseFailures++;

    const row = {
      idx: i,
      instance_id: r.instance_id,
      cell: r.cell,
      category: r.category, category_label: r.category_label,
      question: r.question,
      ground_truth: r.ground_truth,
      answer_content: r.answer_content,
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
  console.log(`[done] ${totalSec}s | judged=${n} trio-correct=${trioCorrect} parse-failures=${parseFailures}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

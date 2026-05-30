#!/usr/bin/env node
// Phase 22 — Cell 3 (substrate retrieval) with gpt-4o-mini SUBJECT
//
// Apples-to-apples re-run of cell-retrieval using gpt-4o-mini as the subject.
// Sample: sample-cells-23-N320.jsonl (80 per category).

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const SAMPLE_FILE = resolve(DATA_DIR, 'sample-cells-23-N320.jsonl');
const RUN_ALL_FILE = resolve(DATA_DIR, 'RUN-all.json');
const OUT_DIR = resolve(DATA_DIR, 'answers');
const OUT_FILE = resolve(OUT_DIR, 'cell-retrieval-gpt4o.jsonl');

const HIVE_MIND_ROOT = process.env.HIVE_MIND_ROOT ?? resolve(__dirname, '..', '..');
const SETUP_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/setup.js`).href;
const RECALL_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/commands/recall-context.js`).href;

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

const SYSTEM_PROMPT =
  'You are answering questions about a long-running conversation. You will be shown ' +
  'the top relevant snippets retrieved from a memory system — NOT the full conversation. ' +
  'The snippets may not contain the full answer. Answer the question as concisely and ' +
  'precisely as possible based on what is given. If the answer is a date, format it as ' +
  'in the snippets. If the snippets don\'t contain enough information, say "Not stated in ' +
  'the retrieved context." Provide ONLY the answer — no preamble, no quoting the question.';

function buildRetrievedContext(hits) {
  return hits.map((h, i) => {
    const lines = String(h.content).split('\n');
    const tag = lines[0];
    const body = lines.slice(1).join('\n').trim();
    return `Snippet ${i + 1} ${tag}\n${body}`;
  }).join('\n\n');
}

async function callGpt4omini(retrievedCtx, question) {
  const userMsg = `Retrieved snippets:\n\n${retrievedCtx}\n\n---\nQuestion: ${question}\n\nAnswer:`;
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
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
  return { content: msg.content ?? '', finish_reason: j.choices?.[0]?.finish_reason ?? null, usage: j.usage ?? null, elapsed_ms };
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

  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 5;
  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null;

  const sample = readFileSync(SAMPLE_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const runAll = JSON.parse(readFileSync(RUN_ALL_FILE, 'utf8'));
  const wsByConv = new Map(runAll.convs.map(c => [c.conv_idx, c.workspace]));
  const total = slice ? Math.min(slice, sample.length) : sample.length;

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);

  const { openPersonalMind } = await import(SETUP_URL);
  const { runRecallContext } = await import(RECALL_URL);
  const env = openPersonalMind();
  await env.getReranker();

  console.log(`[retrieval-gpt4o] subject=${SUBJECT_MODEL} K=${limit} sample=${sample.length} total=${total} resume_from=${resumeFrom}`);
  const tStart = Date.now();
  let succeeded = 0, failed = 0;
  try {
    for (let i = resumeFrom; i < total; i++) {
      const it = sample[i];
      const ws = wsByConv.get(it.conv_idx);
      if (!ws) { console.log(`  [${i + 1}/${total}] no workspace — skip`); failed++; continue; }
      process.stdout.write(`  [${i + 1}/${total}] cat=${it.category_label} ws=c${it.conv_idx} | `);
      try {
        const recall = await runRecallContext({
          query: it.question, scope: 'current', workspace: ws, limit,
          profile: 'balanced', env,
        });
        const ctx = buildRetrievedContext(recall.hits);
        const r = await callGpt4omini(ctx, it.question);
        const row = {
          instance_id: it.instance_id, qa_idx: i, sample_id: it.sample_id,
          conv_idx: it.conv_idx, workspace: ws,
          category: it.category, category_label: it.category_label,
          question: it.question, ground_truth: it.answer, evidence: it.evidence,
          cell: 'retrieval', subject_model: SUBJECT_MODEL, retrieval_k: limit,
          retrieved: recall.hits.map((h, rank) => ({
            rank: rank + 1, frame_id: h.id, score: h.score, from: h.from, content: h.content,
          })),
          answer_content: r.content, finish_reason: r.finish_reason,
          usage: r.usage, elapsed_ms: r.elapsed_ms,
        };
        appendFileSync(OUT_FILE, JSON.stringify(row) + '\n');
        const ans = r.content.replace(/\s+/g, ' ').slice(0, 60);
        console.log(`${(r.elapsed_ms/1000).toFixed(1)}s | "${ans}"`);
        succeeded++;
      } catch (e) {
        appendFileSync(OUT_FILE, JSON.stringify({
          instance_id: it.instance_id, qa_idx: i, cell: 'retrieval',
          error: String(e.message || e), elapsed_ms: 0,
        }) + '\n');
        console.log(`ERR: ${String(e.message || e).slice(0, 100)}`);
        failed++;
      }
    }
  } finally {
    env.close();
  }
  console.log(`[done] ${((Date.now() - tStart)/1000).toFixed(1)}s | ok=${succeeded} fail=${failed}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

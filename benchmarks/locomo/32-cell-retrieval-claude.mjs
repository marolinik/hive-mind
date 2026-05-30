#!/usr/bin/env node
// Phase 32 — Cell 3 (retrieval) with Claude Opus 4.7 SUBJECT, N=80 paired sample.

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const SAMPLE_FILE = resolve(DATA_DIR, 'sample-cells-23.jsonl');
const RUN_ALL_FILE = resolve(DATA_DIR, 'RUN-all.json');
const OUT_DIR = resolve(DATA_DIR, 'answers');
const OUT_FILE = resolve(OUT_DIR, 'cell-retrieval-claude.jsonl');

const HIVE_MIND_ROOT = process.env.HIVE_MIND_ROOT ?? resolve(__dirname, '..', '..');
const SETUP_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/setup.js`).href;
const RECALL_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/commands/recall-context.js`).href;

const SUBJECT_MODEL = 'claude-opus-4-7';

function loadEnv() {
  const envFile = resolve(__dirname, '..', '..', '.env.locomo-trio');
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
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
    return `Snippet ${i + 1} ${lines[0]}\n${lines.slice(1).join('\n').trim()}`;
  }).join('\n\n');
}

async function callClaude(retrievedCtx, question) {
  const userMsg = `Retrieved snippets:\n\n${retrievedCtx}\n\n---\nQuestion: ${question}\n\nAnswer:`;
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: SUBJECT_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  const elapsed_ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  const content = (j.content || []).map(b => b.text || '').join('');
  return { content, stop_reason: j.stop_reason, usage: j.usage, elapsed_ms };
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
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not loaded');
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

  console.log(`[retrieval-claude] subject=${SUBJECT_MODEL} K=${limit} sample=${sample.length} total=${total} resume_from=${resumeFrom}`);
  const tStart = Date.now();
  let ok = 0, fail = 0;
  try {
    for (let i = resumeFrom; i < total; i++) {
      const it = sample[i];
      const ws = wsByConv.get(it.conv_idx);
      if (!ws) { console.log(`  [${i + 1}/${total}] no ws — skip`); fail++; continue; }
      process.stdout.write(`  [${i + 1}/${total}] cat=${it.category_label} ws=c${it.conv_idx} | `);
      try {
        const recall = await runRecallContext({ query: it.question, scope: 'current', workspace: ws, limit, profile: 'balanced', env });
        const ctx = buildRetrievedContext(recall.hits);
        const r = await callClaude(ctx, it.question);
        appendFileSync(OUT_FILE, JSON.stringify({
          instance_id: it.instance_id, qa_idx: i, sample_id: it.sample_id,
          conv_idx: it.conv_idx, workspace: ws,
          category: it.category, category_label: it.category_label,
          question: it.question, ground_truth: it.answer, evidence: it.evidence,
          cell: 'retrieval', subject_model: SUBJECT_MODEL, retrieval_k: limit,
          retrieved: recall.hits.map((h, rank) => ({ rank: rank + 1, frame_id: h.id, score: h.score, from: h.from, content: h.content })),
          answer_content: r.content, stop_reason: r.stop_reason,
          usage: r.usage, elapsed_ms: r.elapsed_ms,
        }) + '\n');
        const ans = r.content.replace(/\s+/g, ' ').slice(0, 60);
        console.log(`${(r.elapsed_ms/1000).toFixed(1)}s | "${ans}"`);
        ok++;
      } catch (e) {
        appendFileSync(OUT_FILE, JSON.stringify({ instance_id: it.instance_id, qa_idx: i, cell: 'retrieval', error: String(e.message || e) }) + '\n');
        console.log(`ERR: ${String(e.message || e).slice(0, 100)}`);
        fail++;
      }
    }
  } finally { env.close(); }
  console.log(`[done] ${((Date.now() - tStart)/1000).toFixed(1)}s | ok=${ok} fail=${fail}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

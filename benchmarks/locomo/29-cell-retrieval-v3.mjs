#!/usr/bin/env node
// Track A v3 — retrieval with LLM-distilled memory facts + categorized + raw.
// Identical to 26-cell-retrieval-v2.mjs except output filename.
// Use after running 28-distill-memory-facts.mjs + rechunk.

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const SAMPLE_FILE = resolve(DATA_DIR, 'sample-cells-23-N320.jsonl');
const RUN_ALL_FILE = resolve(DATA_DIR, 'RUN-all.json');
const OUT_DIR = resolve(DATA_DIR, 'answers');
const OUT_FILE = resolve(OUT_DIR, 'cell-retrieval-gpt4o-v3.jsonl');

const HIVE_MIND_ROOT = 'D:/Projects/hive-mind';
const SETUP_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/setup.js`).href;
const RECALL_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/commands/recall-context.js`).href;
const DB_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/mind/db.js`).href;

const SUBJECT_MODEL = 'gpt-4o-mini';
const SEMANTIC_K = 10;
const IMPORTANCE_K = 5;

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
  'snippets retrieved from a memory system — these include raw dialogue turns, distilled ' +
  'session summaries / observations, AND high-level "memory facts" (preferences, decisions, ' +
  'traits, themes) extracted across the whole conversation. Use the high-level facts when ' +
  'the question requires inference or synthesis. The snippets may not contain the full answer. ' +
  'Answer the question as concisely and precisely as possible. If the answer is a date, format ' +
  'it as in the snippets. If the snippets do not contain enough information, say "Not stated ' +
  'in the retrieved context." Provide ONLY the answer — no preamble, no quoting the question.';

function buildContext(hits) {
  return hits.map((h, i) => {
    const lines = String(h.content).split('\n');
    return `Snippet ${i + 1} ${lines[0]}\n${lines.slice(1).join('\n').trim()}`;
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
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMsg }],
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

function fetchImportantFrames(MindDB, mindPath, limit) {
  const db = new MindDB(mindPath);
  try {
    const raw = db.getDatabase();
    return raw.prepare(
      `SELECT id, content, importance, created_at, source
       FROM memory_frames
       WHERE importance IN ('critical', 'important')
       ORDER BY
         CASE importance WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
         id DESC
       LIMIT ?`
    ).all(limit);
  } finally { db.close(); }
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
  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null;
  const sample = readFileSync(SAMPLE_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const runAll = JSON.parse(readFileSync(RUN_ALL_FILE, 'utf8'));
  const wsByConv = new Map(runAll.convs.map(c => [c.conv_idx, c.workspace]));
  const mindByConv = new Map(runAll.convs.map(c => [c.conv_idx, c.mind_path]));
  const total = slice ? Math.min(slice, sample.length) : sample.length;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);

  const { openPersonalMind } = await import(SETUP_URL);
  const { runRecallContext } = await import(RECALL_URL);
  const { MindDB } = await import(DB_URL);
  const env = openPersonalMind();
  await env.getReranker();

  console.log(`[retrieval-v3] subject=${SUBJECT_MODEL} K_sem=${SEMANTIC_K} K_imp=${IMPORTANCE_K} total=${total} resume=${resumeFrom}`);
  const tStart = Date.now();
  let ok = 0, fail = 0;
  try {
    for (let i = resumeFrom; i < total; i++) {
      const it = sample[i];
      const ws = wsByConv.get(it.conv_idx);
      const mindPath = mindByConv.get(it.conv_idx);
      if (!ws || !mindPath) { console.log(`  [${i + 1}/${total}] no ws — skip`); fail++; continue; }
      process.stdout.write(`  [${i + 1}/${total}] cat=${it.category_label} ws=c${it.conv_idx} | `);
      try {
        const recall = await runRecallContext({ query: it.question, scope: 'current', workspace: ws, limit: SEMANTIC_K, profile: 'balanced', env });
        const imp = fetchImportantFrames(MindDB, mindPath, IMPORTANCE_K);
        const seen = new Set();
        const combined = [];
        for (const f of imp) {
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          combined.push({ content: f.content, source: 'importance', importance: f.importance, id: f.id });
        }
        for (const h of recall.hits) {
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          combined.push({ content: h.content, source: 'semantic', score: h.score, id: h.id });
        }
        const ctx = buildContext(combined);
        const r = await callGpt4omini(ctx, it.question);
        appendFileSync(OUT_FILE, JSON.stringify({
          instance_id: it.instance_id, qa_idx: i, sample_id: it.sample_id,
          conv_idx: it.conv_idx, workspace: ws,
          category: it.category, category_label: it.category_label,
          question: it.question, ground_truth: it.answer, evidence: it.evidence,
          cell: 'retrieval', subject_model: SUBJECT_MODEL,
          semantic_k: SEMANTIC_K, importance_k: IMPORTANCE_K,
          retrieved_count: combined.length,
          retrieved: combined.map((c, rank) => ({ rank: rank + 1, ...c })),
          answer_content: r.content, finish_reason: r.finish_reason,
          usage: r.usage, elapsed_ms: r.elapsed_ms,
        }) + '\n');
        const ans = r.content.replace(/\s+/g, ' ').slice(0, 60);
        console.log(`${(r.elapsed_ms/1000).toFixed(1)}s |${combined.length}h| "${ans}"`);
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

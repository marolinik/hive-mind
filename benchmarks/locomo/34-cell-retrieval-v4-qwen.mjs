#!/usr/bin/env node
// Track A v4-qwen — same v4 retrieval but Qwen3.6-35B-A3B SUBJECT (reference model).
// Identical to 32-cell-retrieval-v4.mjs except subject swapped to DashScope Qwen
// with thinking=ON. Judge stays gpt-4o-mini Mem0 protocol for apples-to-apples.

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const SAMPLE_FILE = resolve(DATA_DIR, 'sample-cells-23-N320.jsonl');
const RUN_ALL_FILE = resolve(DATA_DIR, 'RUN-all.json');
const OUT_DIR = resolve(DATA_DIR, 'answers');
const OUT_FILE = resolve(OUT_DIR, 'cell-retrieval-v4-qwen.jsonl');

const HIVE_MIND_ROOT = 'D:/Projects/hive-mind';
const SETUP_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/setup.js`).href;
const RECALL_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/commands/recall-context.js`).href;
const DB_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/mind/db.js`).href;

const DASHSCOPE_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const SUBJECT_MODEL = 'qwen3.6-35b-a3b';
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
  'three kinds of context: (1) raw dialogue snippets, (2) per-session summaries and ' +
  'observations, (3) a comprehensive set of "memory facts" (preferences, decisions, ' +
  'traits, themes) extracted across the whole conversation.\n\n' +
  'IMPORTANT: When the question asks about character, beliefs, likely behavior, or ' +
  'inference ("would X be considered Y?", "what kind of person is X?", "is X likely to..."), ' +
  'USE the memory facts to infer reasonable answers, even if no single snippet directly ' +
  'states the answer. Synthesize across multiple facts. Only refuse with "Not stated in the ' +
  'retrieved context" if the snippets and facts together provide no relevant signal at all.\n\n' +
  'Answer concisely. If the answer is a date, format it as in the snippets. Provide ONLY ' +
  'the answer — no preamble, no quoting the question.';

function buildContext(distilled, importanceHits, semanticHits) {
  const parts = [];
  if (distilled.length > 0) {
    parts.push(`=== Memory Facts (${distilled.length}) ===\n` +
      distilled.map(f => {
        const lines = String(f.content).split('\n');
        return `• ${lines.slice(1).join(' ').trim()}`;
      }).join('\n'));
  }
  if (importanceHits.length > 0 || semanticHits.length > 0) {
    parts.push(`=== Retrieved Snippets ===`);
    let i = 1;
    for (const h of [...importanceHits, ...semanticHits]) {
      const lines = String(h.content).split('\n');
      parts.push(`Snippet ${i++} ${lines[0]}\n${lines.slice(1).join('\n').trim()}`);
    }
  }
  return parts.join('\n\n');
}

async function callQwen(retrievedCtx, question) {
  const userMsg = `${retrievedCtx}\n\n---\nQuestion: ${question}\n\nAnswer:`;
  const t0 = Date.now();
  const res = await fetch(`${DASHSCOPE_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY}` },
    body: JSON.stringify({
      model: SUBJECT_MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMsg }],
      max_tokens: 8000,
      temperature: 0,
      enable_thinking: true,
    }),
  });
  const elapsed_ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`DashScope ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  const msg = j.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? '',
    reasoning_content: msg.reasoning_content ?? '',
    finish_reason: j.choices?.[0]?.finish_reason ?? null,
    usage: j.usage ?? null,
    elapsed_ms,
  };
}

function fetchDistilledFacts(MindDB, mindPath) {
  const db = new MindDB(mindPath);
  try {
    const raw = db.getDatabase();
    return raw.prepare(
      `SELECT id, content, importance
       FROM memory_frames
       WHERE source = 'system'
         AND (content LIKE '[locomo distilled-fact %' OR content LIKE '[locomo distilled-fact-dense %')
       ORDER BY id ASC`
    ).all();
  } finally { db.close(); }
}

function fetchImportantFrames(MindDB, mindPath, limit) {
  const db = new MindDB(mindPath);
  try {
    const raw = db.getDatabase();
    return raw.prepare(
      `SELECT id, content, importance, created_at, source
       FROM memory_frames
       WHERE importance IN ('critical', 'important')
         AND content NOT LIKE '[locomo distilled-fact%'
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
  if (!process.env.DASHSCOPE_API_KEY) throw new Error('DASHSCOPE_API_KEY not loaded');
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

  const distilledCache = new Map();
  for (const [convIdx, mindPath] of mindByConv) {
    distilledCache.set(convIdx, fetchDistilledFacts(MindDB, mindPath));
  }
  console.log(`[v4-qwen] subject=${SUBJECT_MODEL} thinking=ON K_sem=${SEMANTIC_K} K_imp=${IMPORTANCE_K} | distilled per conv: ${[...distilledCache.entries()].map(([i,f]) => 'c'+i+':'+f.length).join(' ')}`);
  console.log(`         total=${total} resume=${resumeFrom}`);

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
        const importanceHits = fetchImportantFrames(MindDB, mindPath, IMPORTANCE_K);
        const distilled = distilledCache.get(it.conv_idx) ?? [];

        const seen = new Set();
        const distilledKept = distilled.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });
        const importanceKept = importanceHits.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });
        const semanticKept = recall.hits.filter(h => { if (seen.has(h.id)) return false; seen.add(h.id); return true; });

        const ctx = buildContext(distilledKept, importanceKept, semanticKept);
        const r = await callQwen(ctx, it.question);
        const totalHits = distilledKept.length + importanceKept.length + semanticKept.length;

        appendFileSync(OUT_FILE, JSON.stringify({
          instance_id: it.instance_id, qa_idx: i, sample_id: it.sample_id,
          conv_idx: it.conv_idx, workspace: ws,
          category: it.category, category_label: it.category_label,
          question: it.question, ground_truth: it.answer, evidence: it.evidence,
          cell: 'retrieval', subject_model: SUBJECT_MODEL, subject_thinking: true,
          retrieved_count: totalHits,
          distilled_count: distilledKept.length,
          importance_count: importanceKept.length,
          semantic_count: semanticKept.length,
          answer_content: r.content,
          answer_reasoning: r.reasoning_content,
          finish_reason: r.finish_reason,
          usage: r.usage, elapsed_ms: r.elapsed_ms,
        }) + '\n');
        const ans = r.content.replace(/\s+/g, ' ').slice(0, 60);
        console.log(`${(r.elapsed_ms/1000).toFixed(1)}s |d${distilledKept.length}+i${importanceKept.length}+s${semanticKept.length}| "${ans}"`);
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

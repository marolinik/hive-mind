#!/usr/bin/env node
// LongMemEval — substrate retrieval cell WITH the W4 lane stack (Phase 1b-i).
//
// Extends 20-run.mjs with the high-lever lanes forward-ported into hive-mind
// core, no write-time LLM distillation (that is Phase 1b-ii):
//
//   - Turns stored as [mind-rawturn ...] frames with real session dates, so
//     the date-window + raw-detail lanes and temporal scoring all work.
//   - Cross-encoder reranker ON (ONNX, in-process).
//   - Lane A: reranked semantic snippets (HybridSearch), date-window-filtered
//     when the question names an explicit period (parseDateWindow).
//   - Lane B: raw-detail escalation lane (fetchRawDetailLane) — BM25/window
//     pool -> CE rerank top-6 -> +/-1 dialogue-neighbor expansion. The single
//     biggest LoCoMo rung (W3.3 +2.66pp).
//   - Stronger answer policy (W1): commit-to-one-option, granularity-calibrated
//     dates, abstain-when-absent / best-effort-when-speculative.
//
// Usage:
//   node 22-run-lanes.mjs --sample data/sample-100.jsonl --model gpt-4o --k 8 [--limit N]

process.env.HIVE_MIND_NO_SYNTH = '1';
process.env.HIVE_MIND_RAWDETAIL = 'on';

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const ROOT = process.env.HIVE_MIND_ROOT ?? resolve(__dirname, '..', '..');
const CORE = pathToFileURL(resolve(ROOT, 'packages/core/dist/index.js')).href;

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}

const SAMPLE = resolve(process.cwd(), arg('sample', resolve(DATA_DIR, 'sample-100.jsonl')));
const MODEL = arg('model', 'gpt-4o');
const K = parseInt(arg('k', '8'), 10);
const LIMIT = arg('limit', null) ? parseInt(arg('limit'), 10) : null;
const OUT_DIR = resolve(DATA_DIR, 'answers');
const SAMPLE_TAG = basename(SAMPLE).replace(/\.jsonl$/, '');
const OUT_FILE = resolve(OUT_DIR, `answers-${SAMPLE_TAG}-${MODEL.replace(/[^\w.-]/g, '_')}-lanes.jsonl`);

function loadKey() {
  const envPath = process.env.WAGGLE_ENV_PATH ?? 'D:/Projects/waggle-os/.env';
  const txt = readFileSync(envPath, 'utf-8');
  const m = txt.match(/^OPENAI_API_KEY=(.*)$/m);
  if (!m) throw new Error('OPENAI_API_KEY not found');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function sanitizeToken(v) {
  const c = String(v).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return (c || 'x').slice(0, 64);
}
function toIso(dateStr) {
  if (!dateStr) return undefined;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toISOString();
}

const ANSWER_SYSTEM =
  'You answer a question about a long, multi-session user/assistant conversation, using ONLY the retrieved snippets below (not the full history). ' +
  'Snippets may carry a leading (YYYY-MM-DD) date and a user:/assistant: speaker tag. Rules: ' +
  '1) Output ONLY the answer span, concise and precise, no preamble. ' +
  '2) For "when" questions, answer at the date granularity actually stated in the snippets; use the snippet dates. ' +
  '3) For either/or questions, commit to exactly one option. ' +
  '4) If the snippets genuinely do not contain the answer, reply exactly: "I do not know." Never invent facts that are not present. ' +
  '5) If the question asks you to infer or estimate from information that IS present, give a committed best-effort inference.';

async function callModel(key, model, system, user, maxTokens = 512) {
  const isReasoner = /^(gpt-5|o1|o3|o4)/.test(model);
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (isReasoner) body.max_completion_tokens = maxTokens; else { body.max_tokens = maxTokens; body.temperature = 0; }
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return { content: (j.choices?.[0]?.message?.content ?? '').trim(), usage: j.usage ?? null, ms };
}

function countLines(p) {
  if (!existsSync(p) || statSync(p).size === 0) return 0;
  const t = readFileSync(p, 'utf-8'); let n = 0;
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
  if (t[t.length - 1] !== '\n') n++;
  return n;
}

async function main() {
  if (!existsSync(SAMPLE)) throw new Error(`sample not found: ${SAMPLE}`);
  const key = loadKey();
  const core = await import(CORE);
  const { MindDB, FrameStore, SessionStore, HybridSearch, createOllamaEmbedder, createInProcessReranker,
    fetchRawDetailLane, parseDateWindow, rawTurnBody } = core;

  const sample = readFileSync(SAMPLE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const total = LIMIT ? Math.min(LIMIT, sample.length) : sample.length;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);

  const reranker = await createInProcessReranker();
  try { await reranker.scoreBatch('warmup', ['warmup doc']); } catch { /* lazy */ }

  console.log(`[lanes] model=${MODEL} k=${K} sample=${sample.length} total=${total} resume=${resumeFrom}`);
  const tStart = Date.now();
  let ok = 0, fail = 0;

  for (let i = resumeFrom; i < total; i++) {
    const it = sample[i];
    const gopId = it.conversation_id;
    const convKey = sanitizeToken(gopId);
    process.stdout.write(`  [${i + 1}/${total}] ${it.question_type} turns=${it.n_turns} | `);
    const db = new MindDB(':memory:');
    try {
      const frames = new FrameStore(db);
      const sessions = new SessionStore(db);
      const search = new HybridSearch(db, createOllamaEmbedder());
      sessions.ensure(gopId, 'longmemeval', `LME conversation ${gopId}`);

      // Ingest as raw-turn frames with session dates (enables date-window +
      // raw-detail lanes + temporal scoring). Dedup by frame id for vec safety.
      const toIndex = [];
      const seen = new Set();
      let turnIdx = 0;
      for (const turn of it.turns) {
        const speaker = turn.role === 'assistant' ? 'assistant' : 'user';
        const header = `[mind-rawturn conv:${convKey} turn:${turnIdx} speaker:${speaker}]`;
        const content = `${header}\n${turn.content}`;
        const createdAt = toIso(turn.date);
        const f = frames.createIFrame(gopId, content, 'normal', 'import', createdAt);
        turnIdx++;
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        toIndex.push({ id: f.id, content });
      }
      const tIngest = Date.now();
      for (let b = 0; b < toIndex.length; b += 200) await search.indexFramesBatch(toIndex.slice(b, b + 200));
      const ingestMs = Date.now() - tIngest;

      // Date-window from the question (explicit periods only).
      const window = parseDateWindow(it.question);

      // Lane A: reranked semantic snippets (window-filtered when present).
      const tRet = Date.now();
      const semOpts = { limit: K, gopId, profile: 'balanced', reranker, rerankPoolSize: 30 };
      if (window) { semOpts.since = window.since; semOpts.until = window.until; }
      let sem = await search.search(it.question, semOpts);
      if (window && sem.length === 0) { delete semOpts.since; delete semOpts.until; sem = await search.search(it.question, semOpts); }
      const excludeIds = new Set(sem.map((r) => r.frame.id));

      // Lane B: raw-detail escalation lane.
      let raw = [];
      try { raw = await fetchRawDetailLane(db.getDatabase(), it.question, reranker, { window: window ? { since: window.since, until: window.until } : null, excludeIds }); } catch { raw = []; }
      const retMs = Date.now() - tRet;

      // Assemble context: dated snippets then raw dialogue excerpts.
      const datePrefix = (ca) => (ca ? `(${String(ca).slice(0, 10)}) ` : '');
      const semLines = sem.map((r, n) => `Snippet ${n + 1}: ${datePrefix(r.frame.created_at)}${rawTurnBody(String(r.frame.content))}`);
      const rawLines = raw.map((h) => `${datePrefix(h.created_at)}${h.speaker}: ${rawTurnBody(String(h.content))}`);
      const ctxParts = [];
      if (semLines.length) ctxParts.push('# Relevant snippets\n' + semLines.join('\n'));
      if (rawLines.length) ctxParts.push('# Raw dialogue excerpts\n' + rawLines.join('\n'));
      const ctx = ctxParts.join('\n\n') || '(no snippets retrieved)';

      const user = `${ctx}\n\n---\nQuestion: ${it.question}\nAnswer:`;
      const ans = await callModel(key, MODEL, ANSWER_SYSTEM, user);

      appendFileSync(OUT_FILE, JSON.stringify({
        instance_id: it.instance_id, idx: i, question_type: it.question_type, is_abstention: it.is_abstention,
        question: it.question, expected: it.expected, answer: ans.content,
        model: MODEL, k: K, lanes: true, window: window || null, n_turns: it.n_turns, n_ingested: toIndex.length,
        n_semantic: sem.length, n_rawdetail: raw.length,
        ingest_ms: ingestMs, retrieval_ms: retMs, answer_ms: ans.ms, usage: ans.usage,
      }) + '\n');
      console.log(`ing=${(ingestMs / 1000).toFixed(1)}s sem=${sem.length} raw=${raw.length}${window ? ' win' : ''} ans="${ans.content.replace(/\s+/g, ' ').slice(0, 46)}"`);
      ok++;
    } catch (e) {
      appendFileSync(OUT_FILE, JSON.stringify({ instance_id: it.instance_id, idx: i, error: String(e.message || e) }) + '\n');
      console.log(`ERR: ${String(e.message || e).slice(0, 120)}`);
      fail++;
    } finally {
      db.close();
    }
  }
  console.log(`[done] ${((Date.now() - tStart) / 1000).toFixed(1)}s | ok=${ok} fail=${fail} | ${OUT_FILE}`);
}

main().catch((e) => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });

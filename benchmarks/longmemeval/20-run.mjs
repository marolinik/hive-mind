#!/usr/bin/env node
// LongMemEval — substrate retrieval cell.
//
// For each sampled instance: build an ephemeral in-memory mind, ingest the
// question's haystack as one frame per turn, retrieve the top-K frames via
// hive-mind HybridSearch (RRF + scoring, optional cross-encoder rerank), and
// have a COMPARABLE answerer model answer from the retrieved snippets only.
//
// The answerer matches what others publish on LongMemEval (default gpt-4o; the
// Wu et al. paper, mem0, and Supermemory all use GPT-4o; Mastra's 94.87 used
// gpt-5-mini). The substrate cell feeds the model only retrieved snippets, not
// the full ~123K-token haystack, so the answerer cost is small.
//
// Usage:
//   node 20-run.mjs --sample data/sample-50.jsonl --model gpt-4o --k 10 [--rerank] [--limit N]
//
// Keys: read from waggle-os/.env (OPENAI_API_KEY). Override path with
//   WAGGLE_ENV_PATH=/path/to/.env
// Embeddings: local Ollama (nomic-embed-text) via hive-mind's ollama-embedder.

process.env.HIVE_MIND_NO_SYNTH = '1';

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
const has = (name) => process.argv.includes(`--${name}`);

const SAMPLE = resolve(process.cwd(), arg('sample', resolve(DATA_DIR, 'sample-50.jsonl')));
const MODEL = arg('model', 'gpt-4o');
const K = parseInt(arg('k', '10'), 10);
const RERANK = has('rerank');
const LIMIT = arg('limit', null) ? parseInt(arg('limit'), 10) : null;
const OUT_DIR = resolve(DATA_DIR, 'answers');
const SAMPLE_TAG = basename(SAMPLE).replace(/\.jsonl$/, '');
const OUT_FILE = resolve(OUT_DIR, `answers-${SAMPLE_TAG}-${MODEL.replace(/[^\w.-]/g, '_')}${RERANK ? '-rerank' : ''}.jsonl`);

function loadKey() {
  const envPath = process.env.WAGGLE_ENV_PATH ?? 'D:/Projects/waggle-os/.env';
  if (!existsSync(envPath)) throw new Error(`env file not found: ${envPath} (set WAGGLE_ENV_PATH)`);
  const txt = readFileSync(envPath, 'utf-8');
  const m = txt.match(/^OPENAI_API_KEY=(.*)$/m);
  if (!m) throw new Error('OPENAI_API_KEY not in env file');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const ANSWER_SYSTEM =
  'You are answering a question about a long, multi-session conversation between a user and an assistant. ' +
  'You are given the most relevant snippets retrieved from a memory system, NOT the full history. ' +
  'Answer concisely and precisely using ONLY the snippets. Each snippet may carry a "(date)" and a "user:"/"assistant:" speaker tag — use them for temporal questions. ' +
  'If the snippets do not contain enough information to answer, reply exactly: "I do not know." ' +
  'Give ONLY the answer, no preamble, no restating the question.';

function buildContext(hits) {
  return hits
    .map((h, i) => `Snippet ${i + 1}: ${String(h.frame.content)}`)
    .join('\n');
}

async function callModel(key, model, system, user, maxTokens = 512) {
  const isReasoner = /^(gpt-5|o1|o3|o4)/.test(model);
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (isReasoner) body.max_completion_tokens = maxTokens;
  else { body.max_tokens = maxTokens; body.temperature = 0; }
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return { content: (j.choices?.[0]?.message?.content ?? '').trim(), usage: j.usage ?? null, ms };
}

function countLines(p) {
  if (!existsSync(p)) return 0;
  if (statSync(p).size === 0) return 0;
  const t = readFileSync(p, 'utf-8');
  let n = 0;
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
  if (t[t.length - 1] !== '\n') n++;
  return n;
}

async function main() {
  if (!existsSync(SAMPLE)) throw new Error(`sample not found: ${SAMPLE} (run 10-build-sample.mjs)`);
  const key = loadKey();
  const { MindDB, FrameStore, SessionStore, HybridSearch, createOllamaEmbedder, createInProcessReranker } =
    await import(CORE);

  const sample = readFileSync(SAMPLE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const total = LIMIT ? Math.min(LIMIT, sample.length) : sample.length;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);

  let reranker = null;
  if (RERANK) {
    reranker = await createInProcessReranker();
    // warm the ONNX model so the first instance isn't penalized
    try { await reranker.scoreBatch('warmup', ['warmup doc']); } catch { /* lazy load may differ */ }
  }

  console.log(`[run] model=${MODEL} k=${K} rerank=${RERANK} sample=${sample.length} total=${total} resume=${resumeFrom}`);
  const tStart = Date.now();
  let ok = 0, fail = 0;

  for (let i = resumeFrom; i < total; i++) {
    const it = sample[i];
    const gopId = it.conversation_id;
    process.stdout.write(`  [${i + 1}/${total}] ${it.question_type} turns=${it.n_turns} | `);
    const db = new MindDB(':memory:');
    try {
      const frames = new FrameStore(db);
      const sessions = new SessionStore(db);
      const search = new HybridSearch(db, createOllamaEmbedder());
      sessions.ensure(gopId, 'longmemeval', `LME conversation ${gopId}`);

      // Ingest turns as frames, then batch-index vectors. Dedup by frame id:
      // createIFrame returns the EXISTING frame on a content-hash collision
      // (identical turn text), so without this guard the same rowid would be
      // inserted into memory_frames_vec twice (UNIQUE constraint failure).
      const toIndex = [];
      const seen = new Set();
      for (const turn of it.turns) {
        const content = `${turn.role}: ${turn.content}`;
        const f = frames.createIFrame(gopId, content, 'normal', 'import');
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        toIndex.push({ id: f.id, content });
      }
      const tIngest = Date.now();
      for (let b = 0; b < toIndex.length; b += 200) {
        await search.indexFramesBatch(toIndex.slice(b, b + 200));
      }
      const ingestMs = Date.now() - tIngest;

      // Retrieve.
      const tRet = Date.now();
      const opts = { limit: K, gopId, profile: 'balanced' };
      if (reranker) { opts.reranker = reranker; opts.rerankPoolSize = 30; }
      const hits = await search.search(it.question, opts);
      const retMs = Date.now() - tRet;

      // Answer from retrieved snippets.
      const ctx = buildContext(hits);
      const user = `Retrieved snippets:\n${ctx}\n\n---\nQuestion: ${it.question}\nAnswer:`;
      const ans = await callModel(key, MODEL, ANSWER_SYSTEM, user);

      appendFileSync(OUT_FILE, JSON.stringify({
        instance_id: it.instance_id, idx: i, question_type: it.question_type, is_abstention: it.is_abstention,
        question: it.question, expected: it.expected, answer: ans.content,
        model: MODEL, k: K, rerank: RERANK, n_turns: it.n_turns, n_ingested: toIndex.length,
        retrieved: hits.map((h, r) => ({ rank: r + 1, frame_id: h.frame.id, score: h.finalScore, content: String(h.frame.content).slice(0, 400) })),
        ingest_ms: ingestMs, retrieval_ms: retMs, answer_ms: ans.ms, usage: ans.usage,
      }) + '\n');
      console.log(`ing=${(ingestMs / 1000).toFixed(1)}s ret=${retMs}ms ans="${ans.content.replace(/\s+/g, ' ').slice(0, 50)}"`);
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

#!/usr/bin/env node
// LongMemEval — Phase 2: retrieval DEPTH + mind cache + answerer sweep.
//
// Failure analysis of 1b-ii (77.5%) showed 84% of remaining errors are
// temporal (51) + multi-session (37) — categories that need MORE evidence per
// question. 1b-ii fed only ~2K tokens (K=8 + raw-detail 6). SOTA systems feed
// 5-20K. Phase 2 changes, each grounded in a measured failure:
//
//   1. DEPTH: semantic K=24 (cross-encoder pool 60), raw-detail k=10, and a
//      total context cap of ~48K chars (~12K tokens). More recall directly
//      attacks wrong-event retrieval (temporal) and cross-session coverage
//      (multi-session).
//   2. MIND CACHE (--mind-cache, default on): each instance's ingested +
//      embedded mind persists at data/minds/<instance_id>.mind. First run
//      builds it (~30s/instance); every subsequent run (different K, different
//      answerer) reopens it and skips ingest entirely -> a full 500 sweep run
//      drops from ~5.5h to ~1.5h. This makes the multi-answerer sweep cheap.
//   3. ANSWER POLICY: the proven 1b-ii policy VERBATIM (the 1b-iv lesson:
//      restructuring the policy for temporal cost preference -5; so we only
//      APPEND one duration rule + a Current-date context line, changing
//      nothing else).
//
// Usage:
//   node 32-run-phase2.mjs --sample data/sample-500.jsonl --model gpt-4o [--k 24] [--raw-k 10] [--limit N] [--no-synth] [--no-cache]

process.env.HIVE_MIND_NO_SYNTH = '1';
process.env.HIVE_MIND_RAWDETAIL = 'on';

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const MINDS_DIR = resolve(DATA_DIR, 'minds');
const ROOT = process.env.HIVE_MIND_ROOT ?? resolve(__dirname, '..', '..');
const CORE = pathToFileURL(resolve(ROOT, 'packages/core/dist/index.js')).href;

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const has = (n) => process.argv.includes(`--${n}`);

const SAMPLE = resolve(process.cwd(), arg('sample', resolve(DATA_DIR, 'sample-500.jsonl')));
const MODEL = arg('model', 'gpt-4o');
const SYNTH_MODEL = arg('synth-model', 'gpt-4o-mini');
const USE_SYNTH = !has('no-synth');
const USE_CACHE = !has('no-cache');
const K = parseInt(arg('k', '24'), 10);
const RAW_K = parseInt(arg('raw-k', '10'), 10);
const POOL = parseInt(arg('pool', '60'), 10);
const CTX_CHAR_CAP = parseInt(arg('ctx-cap', '48000'), 10);
const LIMIT = arg('limit', null) ? parseInt(arg('limit'), 10) : null;
const OUT_DIR = resolve(DATA_DIR, 'answers');
const SAMPLE_TAG = basename(SAMPLE).replace(/\.jsonl$/, '');
const OUT_FILE = resolve(OUT_DIR, `answers-${SAMPLE_TAG}-${MODEL.replace(/[^\w.-]/g, '_')}-phase2.jsonl`);

function loadKey() {
  const envPath = process.env.WAGGLE_ENV_PATH ?? 'D:/Projects/waggle-os/.env';
  const txt = readFileSync(envPath, 'utf-8');
  const m = txt.match(/^OPENAI_API_KEY=(.*)$/m);
  if (!m) throw new Error('OPENAI_API_KEY not found');
  return m[1].trim().replace(/^["']|["']$/g, '');
}
const sanitizeToken = (v) => (String(v).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x').slice(0, 64);
function toIso(d) { if (!d) return undefined; const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; }
function computeNow(turns) {
  const ds = turns.map((t) => t.date).filter(Boolean).map((d) => String(d).slice(0, 10).replace(/\//g, '-')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return ds.length ? ds[ds.length - 1] : null;
}

// 1b-ii answer policy VERBATIM + appended duration rule (6).
const ANSWER_SYSTEM =
  'You are answering a question about a long, multi-session conversation between a user and an assistant. ' +
  'You are given the most relevant snippets retrieved from a memory system, NOT the full history. ' +
  'Answer concisely and precisely using ONLY the snippets. Each snippet may carry a "(date)" and a "user:"/"assistant:" speaker tag — use them for temporal questions. ' +
  'PREFERENCE / INFERENCE questions (what the user prefers, likes, wants, would choose, or any "infer/estimate" question): give a SPECIFIC inferred answer grounded in the facts present (their stated interests, purchases, brands, activities, constraints). Do NOT say "I do not know" for these when related facts appear in the context — synthesize the most likely answer from those facts. ' +
  'Only reply exactly "I do not know." when the context contains nothing relevant to the question. Never invent facts with no basis in the context. ' +
  'Give ONLY the answer, no preamble, no restating the question. ' +
  'Additionally, for DURATION or "how long since / how many days between" questions: locate each event\'s (YYYY-MM-DD) date in the snippets (and the "Current date" line when the question is relative to now) and COMPUTE the difference precisely.';

const SYNTH_SYSTEM =
  'You compress retrieved conversation snippets into a compact factual profile of the user, focused on what is relevant to the QUESTION. ' +
  'Output 3-8 short bullet lines: stated preferences, owned items/brands, habits, constraints, and key dated facts. No preamble, no speculation beyond what the snippets support. If nothing relevant, output "(no relevant profile facts)".';

async function callModel(key, model, system, user, maxTokens = 512) {
  const isReasoner = /^(gpt-5|o1|o3|o4)/.test(model);
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (isReasoner) body.max_completion_tokens = Math.max(maxTokens, 2048); else { body.max_tokens = maxTokens; body.temperature = 0; }
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
  const ms = Date.now() - t0; const text = await res.text();
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
  const { MindDB, FrameStore, SessionStore, HybridSearch, createOllamaEmbedder, createInProcessReranker,
    fetchRawDetailLane, parseDateWindow, rawTurnBody } = await import(CORE);

  const sample = readFileSync(SAMPLE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const total = LIMIT ? Math.min(LIMIT, sample.length) : sample.length;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  if (USE_CACHE && !existsSync(MINDS_DIR)) mkdirSync(MINDS_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);
  const reranker = await createInProcessReranker();
  try { await reranker.scoreBatch('warmup', ['warmup doc']); } catch { /* lazy */ }

  console.log(`[phase2] model=${MODEL} k=${K} raw-k=${RAW_K} pool=${POOL} cache=${USE_CACHE} synth=${USE_SYNTH ? SYNTH_MODEL : 'off'} total=${total} resume=${resumeFrom}`);
  const tStart = Date.now(); let ok = 0, fail = 0, cacheHits = 0;

  for (let i = resumeFrom; i < total; i++) {
    const it = sample[i]; const gopId = it.conversation_id; const conv = sanitizeToken(gopId);
    const now = computeNow(it.turns);
    process.stdout.write(`  [${i + 1}/${total}] ${it.question_type} | `);
    const mindPath = USE_CACHE ? resolve(MINDS_DIR, `${sanitizeToken(it.instance_id)}.mind`) : ':memory:';
    let db = null;
    try {
      let fresh = true;
      if (USE_CACHE && existsSync(mindPath)) {
        db = new MindDB(mindPath);
        const n = db.getDatabase().prepare('SELECT COUNT(*) AS n FROM memory_frames').get().n;
        const v = db.getDatabase().prepare('SELECT COUNT(*) AS n FROM memory_frames_vec').get().n;
        if (n > 0 && v >= n * 0.95) { fresh = false; cacheHits++; }
        else { db.close(); db = null; rmSync(mindPath, { force: true }); }
      }
      if (!db) db = new MindDB(mindPath);
      const search = new HybridSearch(db, createOllamaEmbedder());
      let ingestMs = 0;
      if (fresh) {
        const frames = new FrameStore(db);
        const sessions = new SessionStore(db);
        sessions.ensure(gopId, 'longmemeval', `LME ${gopId}`);
        const toIndex = []; const seen = new Set(); let t = 0;
        for (const turn of it.turns) {
          const sp = turn.role === 'assistant' ? 'assistant' : 'user';
          const content = `[mind-rawturn conv:${conv} turn:${t} speaker:${sp}]\n${turn.content}`;
          const f = frames.createIFrame(gopId, content, 'normal', 'import', toIso(turn.date));
          t++; if (seen.has(f.id)) continue; seen.add(f.id); toIndex.push({ id: f.id, content });
        }
        const tIngest = Date.now();
        for (let b = 0; b < toIndex.length; b += 200) await search.indexFramesBatch(toIndex.slice(b, b + 200));
        ingestMs = Date.now() - tIngest;
      }

      const window = parseDateWindow(it.question);
      const semOpts = { limit: K, gopId, profile: 'balanced', reranker, rerankPoolSize: POOL };
      if (window) { semOpts.since = window.since; semOpts.until = window.until; }
      let sem = await search.search(it.question, semOpts);
      if (window && sem.length === 0) { delete semOpts.since; delete semOpts.until; sem = await search.search(it.question, semOpts); }
      const excludeIds = new Set(sem.map((r) => r.frame.id));
      let raw = [];
      try { raw = await fetchRawDetailLane(db.getDatabase(), it.question, reranker, { k: RAW_K, window: window ? { since: window.since, until: window.until } : null, excludeIds }); } catch { raw = []; }

      const dp = (ca) => (ca ? `(${String(ca).slice(0, 10)}) ` : '');
      let semLines = sem.map((r, n) => `Snippet ${n + 1}: ${dp(r.frame.created_at)}${rawTurnBody(String(r.frame.content))}`);
      let rawLines = raw.map((h) => `${dp(h.created_at)}${h.speaker}: ${rawTurnBody(String(h.content))}`);
      // Token-budget cap: trim raw lines first, then semantic, never below 8/6.
      const size = (a) => a.reduce((s, l) => s + l.length + 1, 0);
      while (size(semLines) + size(rawLines) > CTX_CHAR_CAP && rawLines.length > 6) rawLines.pop();
      while (size(semLines) + size(rawLines) > CTX_CHAR_CAP && semLines.length > 8) semLines.pop();
      const snippetsBlock = [
        semLines.length ? '# Relevant snippets\n' + semLines.join('\n') : '',
        rawLines.length ? '# Raw dialogue excerpts\n' + rawLines.join('\n') : '',
      ].filter(Boolean).join('\n\n') || '(no snippets retrieved)';

      let profile = '', synthMs = 0;
      if (USE_SYNTH && snippetsBlock.length > 30) {
        try { const s = await callModel(key, SYNTH_MODEL, SYNTH_SYSTEM, `QUESTION: ${it.question}\n\n${snippetsBlock.slice(0, 24000)}\n\nProfile:`, 300); profile = s.content; synthMs = s.ms; } catch { profile = ''; }
      }
      const refLine = now ? `Current date: ${now}\n\n` : '';
      const ctx = refLine + (profile && !/no relevant profile/i.test(profile) ? `# User profile (synthesized)\n${profile}\n\n` : '') + snippetsBlock;
      const ans = await callModel(key, MODEL, ANSWER_SYSTEM, `${ctx}\n\n---\nQuestion: ${it.question}\nAnswer:`);

      appendFileSync(OUT_FILE, JSON.stringify({
        instance_id: it.instance_id, idx: i, question_type: it.question_type, is_abstention: it.is_abstention,
        question: it.question, expected: it.expected, answer: ans.content,
        model: MODEL, synth_model: USE_SYNTH ? SYNTH_MODEL : null, k: K, raw_k: RAW_K, pool: POOL, phase2: true, now, window: window || null,
        n_semantic: sem.length, n_rawdetail: raw.length, n_sem_used: semLines.length, n_raw_used: rawLines.length,
        ctx_chars: ctx.length, had_profile: !!profile, cache_hit: !fresh,
        retrieved_ids: sem.map((r) => r.frame.id).slice(0, 40),
        ingest_ms: ingestMs, synth_ms: synthMs, answer_ms: ans.ms, usage: ans.usage,
      }) + '\n');
      console.log(`${fresh ? `ing=${(ingestMs / 1000).toFixed(1)}s` : 'cache'} sem=${semLines.length} raw=${rawLines.length} ctx=${(ctx.length / 1000).toFixed(0)}k ans="${ans.content.replace(/\s+/g, ' ').slice(0, 38)}"`);
      ok++;
    } catch (e) {
      appendFileSync(OUT_FILE, JSON.stringify({ instance_id: it.instance_id, idx: i, error: String(e.message || e) }) + '\n');
      console.log(`ERR: ${String(e.message || e).slice(0, 120)}`); fail++;
    } finally { if (db) db.close(); }
  }
  console.log(`[done] ${((Date.now() - tStart) / 1000).toFixed(1)}s | ok=${ok} fail=${fail} cacheHits=${cacheHits} | ${OUT_FILE}`);
}

main().catch((e) => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });

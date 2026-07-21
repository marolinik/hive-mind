#!/usr/bin/env node
// LongMemEval — lanes cell + Phase 1b-ii (answer-policy fix + synthesized
// profile card). Separate from 22-run-lanes.mjs so that script stays the exact
// provenance of the Phase 1b-i N=500 run.
//
// Adds on top of 22-run-lanes.mjs:
//   1. ANSWER POLICY: preference/inference questions are answered by INFERRING
//      a specific answer from the facts in the snippets, not by abstaining
//      (the observed 1b-i failure: model had the facts but said "I do not know").
//   2. PROFILE CARD lane: one cheap synthesis call (default gpt-4o-mini) over
//      the retrieved snippets produces a concise per-user profile (preferences,
//      attributes, recurring facts), prepended as the top context lane. This is
//      the retrieved-context analog of the W4 write-time profile card — it adds
//      cross-turn synthesis without distilling the full ~123K haystack.
//
// Usage:
//   node 24-run-lanes-plus.mjs --sample data/sample-500.jsonl --model gpt-4o --k 8 [--synth-model gpt-4o-mini] [--no-synth] [--limit N]

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
const has = (n) => process.argv.includes(`--${n}`);

const SAMPLE = resolve(process.cwd(), arg('sample', resolve(DATA_DIR, 'sample-500.jsonl')));
const MODEL = arg('model', 'gpt-4o');
const SYNTH_MODEL = arg('synth-model', 'gpt-4o-mini');
const USE_SYNTH = !has('no-synth');
const K = parseInt(arg('k', '8'), 10);
const LIMIT = arg('limit', null) ? parseInt(arg('limit'), 10) : null;
const OUT_DIR = resolve(DATA_DIR, 'answers');
const SAMPLE_TAG = basename(SAMPLE).replace(/\.jsonl$/, '');
const OUT_FILE = resolve(OUT_DIR, `answers-${SAMPLE_TAG}-${MODEL.replace(/[^\w.-]/g, '_')}-lanes2.jsonl`);

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
function toIso(d) {
  if (!d) return undefined;
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// Phase 1b-ii answer policy: infer preferences/inferences, don't over-abstain.
const ANSWER_SYSTEM =
  'You answer a question about a long, multi-session user/assistant conversation, using ONLY the context below (a synthesized user profile + retrieved snippets). ' +
  'Snippets may carry a leading (YYYY-MM-DD) date and a user:/assistant: tag. Rules: ' +
  '1) Output ONLY the answer, concise and precise, no preamble. ' +
  '2) For "when" questions, use the snippet dates at the granularity actually stated. ' +
  '3) For either/or questions, commit to exactly one option. ' +
  '4) PREFERENCE / INFERENCE questions (what the user prefers, likes, wants, would choose, or any "infer/estimate" question): give a SPECIFIC inferred answer grounded in the facts present (their stated interests, purchases, brands, activities, constraints). Do NOT say "I do not know" for these when related facts appear in the context — synthesize the most likely answer from those facts. ' +
  '5) Only reply exactly "I do not know." when the context contains nothing relevant to the question. Never invent facts with no basis in the context.';

const SYNTH_SYSTEM =
  'You compress retrieved conversation snippets into a compact factual profile of the user, focused on what is relevant to the QUESTION. ' +
  'Output 3-8 short bullet lines: stated preferences, owned items/brands, habits, constraints, and key dated facts. No preamble, no speculation beyond what the snippets support. If nothing relevant, output "(no relevant profile facts)".';

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
  const { MindDB, FrameStore, SessionStore, HybridSearch, createOllamaEmbedder, createInProcessReranker,
    fetchRawDetailLane, parseDateWindow, rawTurnBody } = await import(CORE);

  const sample = readFileSync(SAMPLE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const total = LIMIT ? Math.min(LIMIT, sample.length) : sample.length;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);
  const reranker = await createInProcessReranker();
  try { await reranker.scoreBatch('warmup', ['warmup doc']); } catch { /* lazy */ }

  console.log(`[lanes2] model=${MODEL} synth=${USE_SYNTH ? SYNTH_MODEL : 'off'} k=${K} total=${total} resume=${resumeFrom}`);
  const tStart = Date.now();
  let ok = 0, fail = 0;

  for (let i = resumeFrom; i < total; i++) {
    const it = sample[i];
    const gopId = it.conversation_id;
    const conv = sanitizeToken(gopId);
    process.stdout.write(`  [${i + 1}/${total}] ${it.question_type} | `);
    const db = new MindDB(':memory:');
    try {
      const frames = new FrameStore(db);
      const sessions = new SessionStore(db);
      const search = new HybridSearch(db, createOllamaEmbedder());
      sessions.ensure(gopId, 'longmemeval', `LME ${gopId}`);
      const toIndex = []; const seen = new Set(); let t = 0;
      for (const turn of it.turns) {
        const sp = turn.role === 'assistant' ? 'assistant' : 'user';
        const content = `[mind-rawturn conv:${conv} turn:${t} speaker:${sp}]\n${turn.content}`;
        const f = frames.createIFrame(gopId, content, 'normal', 'import', toIso(turn.date));
        t++;
        if (seen.has(f.id)) continue;
        seen.add(f.id); toIndex.push({ id: f.id, content });
      }
      const tIngest = Date.now();
      for (let b = 0; b < toIndex.length; b += 200) await search.indexFramesBatch(toIndex.slice(b, b + 200));
      const ingestMs = Date.now() - tIngest;

      const window = parseDateWindow(it.question);
      const semOpts = { limit: K, gopId, profile: 'balanced', reranker, rerankPoolSize: 30 };
      if (window) { semOpts.since = window.since; semOpts.until = window.until; }
      let sem = await search.search(it.question, semOpts);
      if (window && sem.length === 0) { delete semOpts.since; delete semOpts.until; sem = await search.search(it.question, semOpts); }
      const excludeIds = new Set(sem.map((r) => r.frame.id));
      let raw = [];
      try { raw = await fetchRawDetailLane(db.getDatabase(), it.question, reranker, { window: window ? { since: window.since, until: window.until } : null, excludeIds }); } catch { raw = []; }

      const datePrefix = (ca) => (ca ? `(${String(ca).slice(0, 10)}) ` : '');
      const semLines = sem.map((r, n) => `Snippet ${n + 1}: ${datePrefix(r.frame.created_at)}${rawTurnBody(String(r.frame.content))}`);
      const rawLines = raw.map((h) => `${datePrefix(h.created_at)}${h.speaker}: ${rawTurnBody(String(h.content))}`);
      const snippetsBlock = [
        semLines.length ? '# Relevant snippets\n' + semLines.join('\n') : '',
        rawLines.length ? '# Raw dialogue excerpts\n' + rawLines.join('\n') : '',
      ].filter(Boolean).join('\n\n') || '(no snippets retrieved)';

      // Profile-card synthesis lane (cheap; over retrieved snippets).
      let profile = '';
      let synthMs = 0;
      if (USE_SYNTH && snippetsBlock.length > 30) {
        try {
          const s = await callModel(key, SYNTH_MODEL, SYNTH_SYSTEM, `QUESTION: ${it.question}\n\n${snippetsBlock}\n\nProfile:`, 300);
          profile = s.content; synthMs = s.ms;
        } catch { profile = ''; }
      }

      const ctx = (profile && !/no relevant profile/i.test(profile) ? `# User profile (synthesized)\n${profile}\n\n` : '') + snippetsBlock;
      const ans = await callModel(key, MODEL, ANSWER_SYSTEM, `${ctx}\n\n---\nQuestion: ${it.question}\nAnswer:`);

      appendFileSync(OUT_FILE, JSON.stringify({
        instance_id: it.instance_id, idx: i, question_type: it.question_type, is_abstention: it.is_abstention,
        question: it.question, expected: it.expected, answer: ans.content,
        model: MODEL, synth_model: USE_SYNTH ? SYNTH_MODEL : null, k: K, lanes2: true, window: window || null,
        n_semantic: sem.length, n_rawdetail: raw.length, had_profile: !!profile,
        ingest_ms: ingestMs, synth_ms: synthMs, answer_ms: ans.ms, usage: ans.usage,
      }) + '\n');
      console.log(`ing=${(ingestMs / 1000).toFixed(1)}s sem=${sem.length} raw=${raw.length} prof=${profile ? 'y' : 'n'} ans="${ans.content.replace(/\s+/g, ' ').slice(0, 42)}"`);
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

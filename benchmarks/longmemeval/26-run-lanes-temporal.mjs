#!/usr/bin/env node
// LongMemEval — lanes + 1b-ii (profile/policy) + Phase 1b-iii: WRITE-TIME
// relative-date resolution. Separate script so 24-run-lanes-plus stays the
// provenance of the 1b-ii N=500 run.
//
// Adds on top of 24-run-lanes-plus.mjs:
//   WRITE-TIME DATE RESOLUTION (the LoCoMo "P4" rung). At ingest, each turn's
//   first relative cue ("yesterday", "last Saturday", "3 weeks ago", "last
//   year") is resolved against the SESSION date into an absolute event date via
//   core `resolveRelativeDate` (deterministic, no LLM). The resolved date is
//   (a) baked into the frame's created_at timestamp and (b) annotated into the
//   turn body ("[event date: YYYY-MM-DD (cue)]"), so retrieval, the date-window
//   lane, the date-prefix, and the answerer all see the TRUE event date rather
//   than the discussion date. This is the substrate fix for the temporal
//   category (W4 P3 negative result: answer-time date arithmetic does not work).
//
// Usage:
//   node 26-run-lanes-temporal.mjs --sample data/sample-500.jsonl --model gpt-4o --k 8 [--no-synth] [--limit N]

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
const OUT_FILE = resolve(OUT_DIR, `answers-${SAMPLE_TAG}-${MODEL.replace(/[^\w.-]/g, '_')}-lanes3.jsonl`);

function loadKey() {
  const envPath = process.env.WAGGLE_ENV_PATH ?? 'D:/Projects/waggle-os/.env';
  const txt = readFileSync(envPath, 'utf-8');
  const m = txt.match(/^OPENAI_API_KEY=(.*)$/m);
  if (!m) throw new Error('OPENAI_API_KEY not found');
  return m[1].trim().replace(/^["']|["']$/g, '');
}
const sanitizeToken = (v) => (String(v).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x').slice(0, 64);
function toIso(d) { if (!d) return undefined; const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; }

const ANSWER_SYSTEM =
  'You answer a question about a long, multi-session user/assistant conversation, using ONLY the context below (a synthesized user profile + retrieved snippets). ' +
  'Snippets carry a leading (YYYY-MM-DD) date that is the resolved EVENT date (when the thing happened, not when it was discussed) and a user:/assistant: tag. Rules: ' +
  '1) Output ONLY the answer, concise and precise, no preamble. ' +
  '2) For "when" questions use the snippet event dates directly, at the granularity actually stated. ' +
  '3) For either/or questions, commit to exactly one option. ' +
  '4) PREFERENCE / INFERENCE questions: give a SPECIFIC inferred answer grounded in the facts present (interests, purchases, brands, activities, constraints). Do NOT say "I do not know" for these when related facts appear. ' +
  '5) Only reply exactly "I do not know." when the context contains nothing relevant. Never invent facts with no basis in the context.';

const SYNTH_SYSTEM =
  'You compress retrieved conversation snippets into a compact factual profile of the user, focused on the QUESTION. ' +
  'Output 3-8 short bullet lines: stated preferences, owned items/brands, habits, constraints, key dated facts. No preamble, no speculation. If nothing relevant, output "(no relevant profile facts)".';

async function callModel(key, model, system, user, maxTokens = 512) {
  const isReasoner = /^(gpt-5|o1|o3|o4)/.test(model);
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (isReasoner) body.max_completion_tokens = maxTokens; else { body.max_tokens = maxTokens; body.temperature = 0; }
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
    fetchRawDetailLane, parseDateWindow, rawTurnBody, resolveRelativeDate } = await import(CORE);

  const sample = readFileSync(SAMPLE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const total = LIMIT ? Math.min(LIMIT, sample.length) : sample.length;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);
  const reranker = await createInProcessReranker();
  try { await reranker.scoreBatch('warmup', ['warmup doc']); } catch { /* lazy */ }

  console.log(`[lanes3] model=${MODEL} synth=${USE_SYNTH ? SYNTH_MODEL : 'off'} k=${K} total=${total} resume=${resumeFrom} +write-time-date-resolution`);
  const tStart = Date.now(); let ok = 0, fail = 0;

  for (let i = resumeFrom; i < total; i++) {
    const it = sample[i]; const gopId = it.conversation_id; const conv = sanitizeToken(gopId);
    process.stdout.write(`  [${i + 1}/${total}] ${it.question_type} | `);
    const db = new MindDB(':memory:');
    try {
      const frames = new FrameStore(db);
      const sessions = new SessionStore(db);
      const search = new HybridSearch(db, createOllamaEmbedder());
      sessions.ensure(gopId, 'longmemeval', `LME ${gopId}`);
      const toIndex = []; const seen = new Set(); let t = 0; let resolvedCount = 0;
      for (const turn of it.turns) {
        const sp = turn.role === 'assistant' ? 'assistant' : 'user';
        const sessionIso = toIso(turn.date);
        // Write-time date resolution: resolve the first relative cue against the session date.
        const rr = sessionIso ? resolveRelativeDate(turn.content, sessionIso.slice(0, 10)) : null;
        const eventIso = rr ? new Date(`${rr.iso}T00:00:00.000Z`).toISOString() : sessionIso;
        const body = rr ? `${turn.content} [event date: ${rr.iso} (${rr.cue})]` : turn.content;
        if (rr) resolvedCount++;
        const content = `[mind-rawturn conv:${conv} turn:${t} speaker:${sp}]\n${body}`;
        const f = frames.createIFrame(gopId, content, 'normal', 'import', eventIso);
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

      const dp = (ca) => (ca ? `(${String(ca).slice(0, 10)}) ` : '');
      const semLines = sem.map((r, n) => `Snippet ${n + 1}: ${dp(r.frame.created_at)}${rawTurnBody(String(r.frame.content))}`);
      const rawLines = raw.map((h) => `${dp(h.created_at)}${h.speaker}: ${rawTurnBody(String(h.content))}`);
      const snippetsBlock = [
        semLines.length ? '# Relevant snippets\n' + semLines.join('\n') : '',
        rawLines.length ? '# Raw dialogue excerpts\n' + rawLines.join('\n') : '',
      ].filter(Boolean).join('\n\n') || '(no snippets retrieved)';

      let profile = '', synthMs = 0;
      if (USE_SYNTH && snippetsBlock.length > 30) {
        try { const s = await callModel(key, SYNTH_MODEL, SYNTH_SYSTEM, `QUESTION: ${it.question}\n\n${snippetsBlock}\n\nProfile:`, 300); profile = s.content; synthMs = s.ms; } catch { profile = ''; }
      }
      const ctx = (profile && !/no relevant profile/i.test(profile) ? `# User profile (synthesized)\n${profile}\n\n` : '') + snippetsBlock;
      const ans = await callModel(key, MODEL, ANSWER_SYSTEM, `${ctx}\n\n---\nQuestion: ${it.question}\nAnswer:`);

      appendFileSync(OUT_FILE, JSON.stringify({
        instance_id: it.instance_id, idx: i, question_type: it.question_type, is_abstention: it.is_abstention,
        question: it.question, expected: it.expected, answer: ans.content,
        model: MODEL, synth_model: USE_SYNTH ? SYNTH_MODEL : null, k: K, lanes3: true, window: window || null,
        n_semantic: sem.length, n_rawdetail: raw.length, dates_resolved: resolvedCount, had_profile: !!profile,
        ingest_ms: ingestMs, synth_ms: synthMs, answer_ms: ans.ms, usage: ans.usage,
      }) + '\n');
      console.log(`ing=${(ingestMs / 1000).toFixed(1)}s sem=${sem.length} raw=${raw.length} dres=${resolvedCount} ans="${ans.content.replace(/\s+/g, ' ').slice(0, 40)}"`);
      ok++;
    } catch (e) {
      appendFileSync(OUT_FILE, JSON.stringify({ instance_id: it.instance_id, idx: i, error: String(e.message || e) }) + '\n');
      console.log(`ERR: ${String(e.message || e).slice(0, 120)}`); fail++;
    } finally { db.close(); }
  }
  console.log(`[done] ${((Date.now() - tStart) / 1000).toFixed(1)}s | ok=${ok} fail=${fail} | ${OUT_FILE}`);
}

main().catch((e) => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });

// E1b — text-only 6-way question-type classifier (gpt-5-mini).
// Predicts LongMemEval question_type from the QUESTION TEXT ALONE (no gold label,
// no abstention flag, no session content). Prompt is built from the PUBLIC
// LongMemEval ability definitions (Wu et al. 2024) plus generic synthetic
// illustrations authored here — NONE drawn from the 500 benchmark questions.
// Emits data/e1b-classpreds.jsonl (NEW file; never overwrites). Resumable.
//
// Usage: node 91a-classify-e1b.mjs [--limit N] [--concurrency 8]
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const D = resolve(__dirname, 'data');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const LIMIT = arg('limit') ? +arg('limit') : 0;
const CONC = +arg('concurrency', '8');
const MODEL = 'gpt-5-mini';
const OUT = resolve(D, 'e1b-classpreds.jsonl');

const loadKey = () => { const m = readFileSync(process.env.WAGGLE_ENV_PATH ?? 'D:/Projects/waggle-os/.env', 'utf-8').match(/^OPENAI_API_KEY=(.*)$/m); if (!m) throw new Error('no key'); return m[1].trim().replace(/^["']|["']$/g, ''); };
const load = (p) => existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const countLines = (p) => { if (!existsSync(p) || statSync(p).size === 0) return 0; const t = readFileSync(p, 'utf-8'); return t.trim() ? t.trim().split('\n').length : 0; };

const LABELS = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'multi-session', 'knowledge-update', 'temporal-reasoning'];

const SYSTEM =
`You classify a question posed to a memory system about a long, multi-session chat history between a USER and an ASSISTANT. Using ONLY the wording of the question, output which ONE of six LongMemEval question types it is. You do NOT see the conversation; judge purely from what the question asks for.

Definitions (LongMemEval, Wu et al. 2024):

1. single-session-user — Recall of a specific fact the USER stated about themselves/their life within a single conversation (a detail, event, name, number, plan the user mentioned). Answerable from one session's user messages.
   e.g. "What breed is the dog I adopted?" / "Which city did I say I was flying to for the conference?"

2. single-session-assistant — Recall of something the ASSISTANT said, did, recommended, or produced earlier (advice given, a name/list/plan the assistant offered). Answerable from one session's assistant messages.
   e.g. "What book did you recommend when I asked for a thriller?" / "Which three exercises did you suggest for my back?"

3. single-session-preference — The USER expressed a preference, taste, constraint, or dislike, and the question asks for a recommendation or choice that should HONOR that preference. Preference-aware personalization within a session.
   e.g. "Given what you know I like, suggest a restaurant for tonight." / "Recommend a weekend activity that fits my taste."

4. multi-session — Answering requires AGGREGATING, COUNTING, SUMMING, LISTING, or COMPARING information SPREAD ACROSS MULTIPLE sessions/occasions. The signal is synthesis over many mentions.
   e.g. "How many books have I told you I finished this year?" / "What is the total I've spent on the trips we discussed?"

5. knowledge-update — A fact CHANGED over time (the user updated it), and the question asks for the CURRENT / latest / most-recent value, requiring recognition that an earlier value was superseded.
   e.g. "What is my current job title?" / "Where do I live now?" / "What's my latest weight goal?"

6. temporal-reasoning — The question requires reasoning about TIME: when something happened, ordering of events, durations, "how long ago", "how many days/months between", first/last/most-recent-by-date.
   e.g. "How many months ago did I start the new job?" / "Which happened first, the move or the promotion?" / "How long between my two trips?"

Decision guidance:
- "current / now / latest / these days" asking for a value that plausibly changed -> knowledge-update.
- explicit time math, durations, ordering, "how long / how many days/months ago / between" -> temporal-reasoning.
- counting/summing/listing/comparing across many separate mentions -> multi-session.
- asks for a suggestion/recommendation tailored to the user's taste/constraints -> single-session-preference.
- a single thing the ASSISTANT said/recommended -> single-session-assistant.
- otherwise a single fact the USER stated -> single-session-user.

Reply with EXACTLY one label from this set, lowercase, nothing else:
single-session-user | single-session-assistant | single-session-preference | multi-session | knowledge-update | temporal-reasoning`;

async function callOpenAI(key, system, user, timeoutMs = 60000) {
  const body = { model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_completion_tokens: 3000, reasoning_effort: 'low' };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: ctrl.signal });
      const t = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      return (JSON.parse(t).choices?.[0]?.message?.content ?? '').trim();
    } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

function parseLabel(raw) {
  const s = String(raw).toLowerCase();
  // exact match first, then substring containment (longest label wins)
  for (const l of LABELS) if (s === l) return l;
  const hits = LABELS.filter((l) => s.includes(l)).sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
}

async function main() {
  const key = loadKey();
  let sample = load(resolve(D, 'sample-500.jsonl'));
  if (LIMIT) sample = sample.slice(0, LIMIT);
  const done = new Set(load(OUT).map((r) => r.instance_id));
  const pool = sample.filter((it) => !done.has(it.instance_id));
  console.log(`[e1b-classify] model=${MODEL} pool=${pool.length} (done ${done.size}) -> ${OUT}`);
  let idx = 0, n = 0;
  async function worker() {
    while (idx < pool.length) {
      const it = pool[idx++];
      try {
        const raw = await callOpenAI(key, SYSTEM, `Question: ${it.question}\nType:`);
        const pred = parseLabel(raw);
        appendFileSync(OUT, JSON.stringify({ instance_id: it.instance_id, question: it.question, true_type: it.question_type, pred, raw: pred ? undefined : raw.slice(0, 120) }) + '\n');
      } catch (e) {
        appendFileSync(OUT, JSON.stringify({ instance_id: it.instance_id, question: it.question, true_type: it.question_type, pred: null, error: String(e).slice(0, 160) }) + '\n');
      }
      if (++n % 25 === 0) console.log(`  ${n}/${pool.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, pool.length) }, worker));
  console.log(`done. total lines: ${countLines(OUT)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// LongMemEval — LLM-as-judge scoring (CORRECT / WRONG).
//
// Mirrors the common LongMemEval / Mem0 "be generous" judge protocol so the
// number is comparable to published results. Judge model defaults to gpt-4o
// (the canonical LongMemEval answerer+judge). Abstention questions (_abs) are
// scored deterministically: correct iff the answer abstains.
//
// Usage:
//   node 30-judge.mjs --answers data/answers/answers-gpt-4o.jsonl --judge gpt-4o

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}

const ANSWERS = resolve(process.cwd(), arg('answers', resolve(DATA_DIR, 'answers/answers-gpt-4o.jsonl')));
const JUDGE = arg('judge', 'gpt-4o');
const OUT_DIR = resolve(DATA_DIR, 'judgments');
const OUT_FILE = resolve(OUT_DIR, `judged-${basename(ANSWERS).replace(/\.jsonl$/, '')}-by-${JUDGE.replace(/[^\w.-]/g, '_')}.jsonl`);

function loadKey() {
  const envPath = process.env.WAGGLE_ENV_PATH ?? 'D:/Projects/waggle-os/.env';
  const txt = readFileSync(envPath, 'utf-8');
  const m = txt.match(/^OPENAI_API_KEY=(.*)$/m);
  if (!m) throw new Error('OPENAI_API_KEY not found');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const ABSTAIN_RE = /\b(i (do not|don'?t) know|not (mentioned|stated|specified|provided|available|discussed|enough)|no (information|mention|record)|cannot (determine|find|tell)|unclear|unknown)\b/i;

const JUDGE_SYSTEM =
  'You are an expert grader. Label the ANSWER to the QUESTION as CORRECT or WRONG, using the GOLD answer as ground truth. ' +
  'Be generous: if the answer conveys the same meaning as the gold it is CORRECT, even if phrased differently, more verbose, or with extra correct detail. ' +
  'It is WRONG if it omits the key information the gold requires, contradicts the gold, or claims not to know when the gold has a definite answer. ' +
  'Reply with exactly one word: CORRECT or WRONG.';

async function judge(key, model, q, gold, answer) {
  const isReasoner = /^(gpt-5|o1|o3|o4)/.test(model);
  const user = `QUESTION: ${q}\nGOLD: ${gold}\nANSWER: ${answer}\n\nVerdict (CORRECT or WRONG):`;
  const body = { model, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }] };
  if (isReasoner) body.max_completion_tokens = 8; else { body.max_tokens = 4; body.temperature = 0; }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  const verdict = (j.choices?.[0]?.message?.content ?? '').trim().toUpperCase();
  return verdict.startsWith('CORRECT');
}

function countLines(p) {
  if (!existsSync(p) || statSync(p).size === 0) return 0;
  const t = readFileSync(p, 'utf-8'); let n = 0;
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
  if (t[t.length - 1] !== '\n') n++;
  return n;
}

async function main() {
  if (!existsSync(ANSWERS)) throw new Error(`answers not found: ${ANSWERS}`);
  const key = loadKey();
  const rows = readFileSync(ANSWERS, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !r.error);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resume = countLines(OUT_FILE);
  console.log(`[judge] judge=${JUDGE} rows=${rows.length} resume=${resume} -> ${OUT_FILE}`);

  for (let i = resume; i < rows.length; i++) {
    const r = rows[i];
    const gold = Array.isArray(r.expected) ? r.expected.join(' | ') : String(r.expected);
    let correct, method;
    try {
      if (r.is_abstention) { correct = ABSTAIN_RE.test(r.answer || ''); method = 'abstention-regex'; }
      else { correct = await judge(key, JUDGE, r.question, gold, r.answer || ''); method = 'llm-judge'; }
      appendFileSync(OUT_FILE, JSON.stringify({
        instance_id: r.instance_id, question_type: r.question_type, is_abstention: !!r.is_abstention,
        correct, method, gold, answer: r.answer,
      }) + '\n');
      process.stdout.write(correct ? '.' : 'x');
    } catch (e) {
      appendFileSync(OUT_FILE, JSON.stringify({ instance_id: r.instance_id, error: String(e.message || e) }) + '\n');
      process.stdout.write('E');
    }
  }
  console.log(`\n[judge] done -> ${OUT_FILE}`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

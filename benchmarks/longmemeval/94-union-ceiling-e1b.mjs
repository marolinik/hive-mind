// TASK 2 addendum — method-union ceiling (analysis only). For each E1b-wrong instance,
// check whether ANY already-run method/variant judged it correct. Separates
// "method-recoverable" (some existing artifact got it right -> a smarter selector could
// too) from "substrate-floor" (no existing method got it -> needs observation-layer work).
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const D = resolve(__dirname, 'data');
const load = (p) => existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const jbool = (f) => new Map(load(resolve(D, 'judgments', f)).filter((r) => !r.error).map((r) => [r.instance_id, !!r.correct]));

const METHOD = { 'single-session-assistant': 'qd', 'knowledge-update': 'qd', 'single-session-user': 'h3', 'single-session-preference': 'h3', 'temporal-reasoning': 'vh5', 'multi-session': 'vh5' };
const sample = load(resolve(D, 'sample-500.jsonl'));
const trueCat = new Map(sample.map((it) => [it.instance_id, it.question_type]));
const predCat = new Map(load(resolve(D, 'e1b-classpreds.jsonl')).map((r) => [r.instance_id, r.pred]));

// every full-500 (and recompute) judged method we have on disk
const FILES = [
  'official-answers-sample-500-gpt-5-mini-obs-qd-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-h3t-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-h3p-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-h3u-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-h3k-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-vh5-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-vh5L-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-vh5b-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-obs-qd-vh5g5-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-ms24-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-msraw24-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-mshigh-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-hybrid-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-hybrid2-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-hybrid3-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-fullctx-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-decomp-by-gpt-4o.jsonl',
  'official-answers-sample-500-gpt-5-mini-obs-qd-esc-by-gpt-4o.jsonl',
  'official-answers-sample-e1bfsh3-gpt-5-mini-obs-qd-fsh3-by-gpt-4o.jsonl',
  'official-answers-sample-e1bfsvh5-gpt-5-mini-obs-qd-fsvh5-by-gpt-4o.jsonl',
];
const maps = FILES.map((f) => [f.replace('official-answers-sample-500-gpt-5-mini-obs-qd-', '').replace('-by-gpt-4o.jsonl', ''), jbool(f)]);
const qdJ = jbool('official-answers-sample-500-gpt-5-mini-obs-qd-by-gpt-4o.jsonl');
const h3J = new Map(); for (const f of ['h3t', 'h3p', 'h3u', 'h3k']) for (const [k, v] of jbool(`official-answers-sample-500-gpt-5-mini-obs-qd-${f}-by-gpt-4o.jsonl`)) h3J.set(k, v);
for (const [k, v] of jbool('official-answers-sample-e1bfsh3-gpt-5-mini-obs-qd-fsh3-by-gpt-4o.jsonl')) h3J.set(k, v);
const vh5J = jbool('official-answers-sample-500-gpt-5-mini-obs-qd-vh5-by-gpt-4o.jsonl');
for (const [k, v] of jbool('official-answers-sample-e1bfsvh5-gpt-5-mini-obs-qd-fsvh5-by-gpt-4o.jsonl')) vh5J.set(k, v);
const e1bRealized = (id) => { const m = METHOD[predCat.get(id)]; if (m === 'qd') return qdJ.get(id); if (m === 'h3') return h3J.has(id) ? h3J.get(id) : qdJ.get(id); return vh5J.has(id) ? vh5J.get(id) : qdJ.get(id); };

const wrong = sample.filter((it) => !e1bRealized(it.instance_id));
let recoverable = 0, floor = 0; const byCatRec = {}, byCatFloor = {};
const recBy = {};
for (const it of wrong) {
  const id = it.instance_id, tc = it.question_type;
  const hits = maps.filter(([, m]) => m.get(id) === true).map(([name]) => name);
  if (hits.length) { recoverable++; (byCatRec[tc] ??= 0), byCatRec[tc]++; for (const h of hits) recBy[h] = (recBy[h] || 0) + 1; }
  else { floor++; (byCatFloor[tc] ??= 0), byCatFloor[tc]++; }
}
console.log(`E1b-wrong total: ${wrong.length}`);
console.log(`method-recoverable (some existing artifact judged correct): ${recoverable}`);
console.log(`substrate-floor (NO existing method got it right)          : ${floor}`);
console.log(`\nrecoverable by true category:`, byCatRec);
console.log(`floor by true category      :`, byCatFloor);
console.log(`\nwhich artifacts recover the recoverable misses (count):`);
for (const [k, v] of Object.entries(recBy).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${v}`);
console.log(`\nInterpretation: a PERFECT label-free selector over already-run methods could reach at most`);
console.log(`  ${461 + recoverable}/500 = ${(100 * (461 + recoverable) / 500).toFixed(2)} micro (upper bound, not realizable without an oracle selector).`);
console.log(`  The ${floor} floor misses need NEW method/observation work, not selection.`);

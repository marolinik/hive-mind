// E1b — classifier-routed score (production-legal: routing from question TEXT only).
// Routing model = 42-compose-final: H3_CATS {temporal-reasoning, single-session-preference}
// -> h3 (full-log hybrid) path; every other predicted type -> qd (retrieval) path.
// This isolates the ROUTING lever exactly: uniform all-qd = 88.20 micro (E1),
// oracle-routed (route by TRUE label) = 91.20 micro (42-compose-final).
//
// Answer reuse (NO new spend):
//   pred qd-side  -> qd judged answer (exists for all 500)
//   pred h3-side & instance has an h3-path judged answer (h3t/h3p/h3u/h3k) -> reuse it
//   pred h3-side & NO h3 answer for instance (true in {SSA, MS}) -> MISMATCH.
// Mismatch handling: reports lower bound (all wrong), upper bound (all right),
// qd-fallback proxy (use the always-available qd answer), and — if a recomputed
// h3 answers file is supplied via --h3mis <file of judged {instance_id,correct}> —
// the exact realized score.
//
// Usage: node 91-score-e1b.mjs [--h3mis data/judgments/<file>.jsonl]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const D = resolve(__dirname, 'data');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : null; };
const load = (p) => existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const CATS = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'multi-session', 'knowledge-update', 'temporal-reasoning'];
const H3_CATS = new Set(['temporal-reasoning', 'single-session-preference']);

const sample = load(resolve(D, 'sample-500.jsonl'));
const trueCat = new Map(sample.map((it) => [it.instance_id, it.question_type]));
const preds = load(resolve(D, 'e1b-classpreds.jsonl'));
const predCat = new Map(preds.map((r) => [r.instance_id, r.pred]));

// judged correctness per method, keyed by instance_id
const jmap = (file) => new Map(load(resolve(D, 'judgments', file)).filter((r) => !r.error).map((r) => [r.instance_id, !!r.correct]));
const qdJ = jmap('official-answers-sample-500-gpt-5-mini-obs-qd-by-gpt-4o.jsonl');
const h3J = new Map();
for (const f of ['h3t', 'h3p', 'h3u', 'h3k']) for (const [k, v] of jmap(`official-answers-sample-500-gpt-5-mini-obs-qd-${f}-by-gpt-4o.jsonl`)) h3J.set(k, v);
// optional recomputed h3 answers for the mismatch set
const h3misJ = new Map();
if (arg('h3mis')) for (const r of load(resolve(__dirname, arg('h3mis')))) if (!r.error) h3misJ.set(r.instance_id, !!r.correct);

// routed correctness under a given label-source (pred or true), no-spend policy.
// returns {correct, mismatch:Set, per:{cat:{n,c}}, realized:Map}
function routeScore(labelOf, { mismatchAs = 'skip' } = {}) {
  let n = 0, c = 0; const per = {}; const mismatch = new Set(); const realized = new Map();
  for (const it of sample) {
    const t = it.question_type; const lbl = labelOf(it.instance_id);
    (per[t] ??= { n: 0, c: 0 }); per[t].n++; n++;
    const h3side = H3_CATS.has(lbl);
    let ok;
    if (!h3side) ok = qdJ.get(it.instance_id);            // qd path (always available)
    else if (h3J.has(it.instance_id)) ok = h3J.get(it.instance_id); // h3 reuse
    else if (h3misJ.has(it.instance_id)) ok = h3misJ.get(it.instance_id); // recomputed
    else { // mismatch, no h3 answer
      mismatch.add(it.instance_id);
      if (mismatchAs === 'wrong') ok = false;
      else if (mismatchAs === 'right') ok = true;
      else if (mismatchAs === 'qd') ok = qdJ.get(it.instance_id);
      else ok = null; // skip from tally
    }
    if (ok === null) { per[t].n--; n--; continue; }
    realized.set(it.instance_id, ok);
    if (ok) { per[t].c++; c++; }
  }
  const cats = CATS.filter((k) => per[k]);
  const macro = cats.reduce((s, k) => s + per[k].c / per[k].n, 0) / cats.length;
  return { n, c, micro: 100 * c / n, macro: 100 * macro, per, mismatch, realized };
}

const pl = (id) => predCat.get(id);
const tl = (id) => trueCat.get(id);

// --- Oracle sanity (route by TRUE label) should equal 42-compose 91.20 ---
const oracle = routeScore(tl);

// --- Method-bucket routing accuracy (path-level, not 6-way) ---
const bucket = (lbl) => H3_CATS.has(lbl) ? 'h3' : 'qd';
let sixCorrect = 0, pathCorrect = 0;
for (const it of sample) { if (pl(it.instance_id) === it.question_type) sixCorrect++; if (bucket(pl(it.instance_id)) === bucket(it.question_type)) pathCorrect++; }

// --- E1b classifier-routed, four mismatch treatments ---
const lo = routeScore(pl, { mismatchAs: 'wrong' });
const hi = routeScore(pl, { mismatchAs: 'right' });
const qdfb = routeScore(pl, { mismatchAs: 'qd' });
// EXACT: recomputed h3 answers fold in via h3misJ reuse branch; any instance still
// lacking an h3 answer (no cached mind) falls back to its qd answer (realistic router fallback).
const exact = h3misJ.size ? routeScore(pl, { mismatchAs: 'qd' }) : null;

function line(label, r) {
  console.log(`${label.padEnd(34)} ${r.micro.toFixed(2).padStart(6)} micro  ${r.macro.toFixed(2).padStart(6)} macro  (${r.c}/${r.n})`);
}
console.log('=== E1b: classifier-routed (42-compose routing, text-only labels) ===\n');
console.log(`6-way classifier accuracy : ${(100 * sixCorrect / sample.length).toFixed(2)}%  (${sixCorrect}/${sample.length})`);
console.log(`path-bucket routing acc   : ${(100 * pathCorrect / sample.length).toFixed(2)}%  (h3 vs qd bucket)  (${pathCorrect}/${sample.length})`);
console.log(`h3-side mismatches (need recompute): ${lo.mismatch.size}\n`);
line('uniform all-qd (E1)', { micro: 88.20, macro: NaN, c: '441', n: 500 });
line('oracle-routed (42-compose)', oracle);
console.log('--- E1b classifier-routed ---');
line('  lower bound (mismatch=wrong)', lo);
line('  upper bound (mismatch=right)', hi);
line('  qd-fallback proxy', qdfb);
if (exact) line(`  EXACT (${h3misJ.size} h3 recomputed +qd-fb)`, exact);

console.log('\nper-category (qd-fallback proxy):');
console.log('category                         acc%     n');
for (const k of CATS) { const p = qdfb.per[k]; if (p) console.log(`${k.padEnd(32)} ${(100 * p.c / p.n).toFixed(1).padStart(6)}  ${String(p.n).padStart(4)}`); }

// mismatch set for optional recompute
const misIds = [...lo.mismatch];
writeFileSync(resolve(D, 'e1b-h3-mismatch-ids.json'), JSON.stringify(misIds, null, 2) + '\n');
console.log(`\nwrote ${misIds.length} mismatch instance_ids -> data/e1b-h3-mismatch-ids.json`);

// emit results JSON
const out = {
  experiment: 'E1b',
  routing_model: '42-compose-final (H3_CATS{temporal-reasoning,single-session-preference}->h3, else qd)',
  classifier: { model: 'gpt-5-mini', prompt: 'definition-based, question-text-only, no benchmark examples', six_way_accuracy_pct: +(100 * sixCorrect / sample.length).toFixed(2), path_bucket_accuracy_pct: +(100 * pathCorrect / sample.length).toFixed(2) },
  references: { uniform_all_qd_micro: 88.20, oracle_routed_42compose: { micro: +oracle.micro.toFixed(2), macro: +oracle.macro.toFixed(2) }, published_full_stack: { micro: 93.60, macro: 95.01 }, mastra_macro: 94.87 },
  h3_mismatch_count: lo.mismatch.size,
  e1b_classifier_routed: {
    lower_bound: { micro: +lo.micro.toFixed(2), macro: +lo.macro.toFixed(2) },
    upper_bound: { micro: +hi.micro.toFixed(2), macro: +hi.macro.toFixed(2) },
    qd_fallback_proxy: { micro: +qdfb.micro.toFixed(2), macro: +qdfb.macro.toFixed(2), per_category: qdfb.per },
    exact: exact ? { micro: +exact.micro.toFixed(2), macro: +exact.macro.toFixed(2), per_category: exact.per, h3_recomputed: h3misJ.size, note: 'misrouted true-MS->h3 answers recomputed; 1 instance without a cached mind uses qd fallback' } : null,
  },
};
writeFileSync(resolve(D, 'results-e1b-classifier.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote data/results-e1b-classifier.json');

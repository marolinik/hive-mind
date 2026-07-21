// TASK 2 — miss analysis on the E1b-exact full-stack run (analysis only, no model calls).
// Reproduces 92-score-e1b-fullstack.mjs realized() logic EXACTLY, then:
//  (A) classifies every E1b-wrong instance: misroute-recoverable vs method-failure,
//      cross-checked against the oracle-routed realized correctness.
//  (B) computes label-free lever counterfactuals from EXISTING judgment files only.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const D = resolve(__dirname, 'data');
const load = (p) => existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
// judgment -> Map(id -> {correct, gold, answer})
const jrec = (f) => new Map(load(resolve(D, 'judgments', f)).filter((r) => !r.error).map((r) => [r.instance_id, r]));
const bool = (m) => new Map([...m].map(([k, v]) => [k, !!v.correct]));

const CATS = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'multi-session', 'knowledge-update', 'temporal-reasoning'];
const METHOD = { 'single-session-assistant': 'qd', 'knowledge-update': 'qd', 'single-session-user': 'h3', 'single-session-preference': 'h3', 'temporal-reasoning': 'vh5', 'multi-session': 'vh5' };

const sample = load(resolve(D, 'sample-500.jsonl'));
const trueCat = new Map(sample.map((it) => [it.instance_id, it.question_type]));
const predCat = new Map(load(resolve(D, 'e1b-classpreds.jsonl')).map((r) => [r.instance_id, r.pred]));

// realized-method judgment record maps (with answer/gold for inspection)
const qdR = jrec('official-answers-sample-500-gpt-5-mini-obs-qd-by-gpt-4o.jsonl');
const h3R = new Map();
for (const f of ['h3t', 'h3p', 'h3u', 'h3k']) for (const [k, v] of jrec(`official-answers-sample-500-gpt-5-mini-obs-qd-${f}-by-gpt-4o.jsonl`)) h3R.set(k, v);
for (const [k, v] of jrec('official-answers-sample-e1bfsh3-gpt-5-mini-obs-qd-fsh3-by-gpt-4o.jsonl')) h3R.set(k, v);
const vh5R = jrec('official-answers-sample-500-gpt-5-mini-obs-qd-vh5-by-gpt-4o.jsonl');
for (const [k, v] of jrec('official-answers-sample-e1bfsvh5-gpt-5-mini-obs-qd-fsvh5-by-gpt-4o.jsonl')) vh5R.set(k, v);

const qdJ = bool(qdR), h3J = bool(h3R), vh5J = bool(vh5R);
// realized correctness under a method (mirrors scorer: h3/vh5 fall back to qd when absent)
function realized(id, method) {
  if (method === 'qd') return { ok: qdJ.get(id), src: 'qd', rec: qdR.get(id), fb: false };
  if (method === 'h3') return h3J.has(id) ? { ok: h3J.get(id), src: 'h3', rec: h3R.get(id), fb: false } : { ok: qdJ.get(id), src: 'qd(fb)', rec: qdR.get(id), fb: true };
  if (method === 'vh5') return vh5J.has(id) ? { ok: vh5J.get(id), src: 'vh5', rec: vh5R.get(id), fb: false } : { ok: qdJ.get(id), src: 'qd(fb)', rec: qdR.get(id), fb: true };
}

// per-instance E1b vs oracle
const rows = sample.map((it) => {
  const id = it.instance_id, tc = it.question_type, pc = predCat.get(id);
  const em = METHOD[pc], om = METHOD[tc];
  const e = realized(id, em), o = realized(id, om);
  return { id, tc, pc, em, om, e_ok: !!e.ok, o_ok: !!o.ok, e_src: e.src, o_src: o.src, e_fb: e.fb, e_rec: e.rec, o_rec: o.rec, is_abs: !!it.is_abstention };
});

const microE = rows.filter((r) => r.e_ok).length;
const microO = rows.filter((r) => r.o_ok).length;
console.log(`E1b realized correct: ${microE}/500 (${(100 * microE / 500).toFixed(2)})`);
console.log(`oracle realized correct: ${microO}/500 (${(100 * microO / 500).toFixed(2)})`);

// (A) classify E1b-wrong
const wrong = rows.filter((r) => !r.e_ok);
const misrouteRecoverable = wrong.filter((r) => r.em !== r.om && r.o_ok);   // true route would fix
const methodFailSameRoute = wrong.filter((r) => r.em === r.om);            // same route both arms, still wrong
const methodFailDiffRoute = wrong.filter((r) => r.em !== r.om && !r.o_ok); // rerouted AND oracle route also wrong
console.log(`\n=== (A) E1b-wrong classification (n=${wrong.length}) ===`);
console.log(`(i)  misroute-recoverable (true route correct)      : ${misrouteRecoverable.length}`);
console.log(`(ii) method-failure, same route as oracle           : ${methodFailSameRoute.length}`);
console.log(`(ii) method-failure, rerouted but oracle also wrong : ${methodFailDiffRoute.length}`);
// misroute GAINS: E1b correct where oracle route wrong (classifier accidentally helped)
const misrouteGain = rows.filter((r) => r.e_ok && r.em !== r.om && !r.o_ok);
console.log(`misroute GAINS (E1b right, oracle route wrong)      : ${misrouteGain.length}`);
console.log(`net misroute cost = recoverable - gains = ${misrouteRecoverable.length} - ${misrouteGain.length} = ${misrouteRecoverable.length - misrouteGain.length}`);

// wrong-by-true-category
const byCat = {};
for (const r of wrong) (byCat[r.tc] ??= { n: 0, misroute: 0, method: 0 }), byCat[r.tc].n++, (r.em !== r.om && r.o_ok ? byCat[r.tc].misroute++ : byCat[r.tc].method++);
console.log(`\nE1b-wrong by TRUE category (n / misroute-recoverable / method-fail):`);
for (const c of CATS) if (byCat[c]) console.log(`  ${c.padEnd(28)} ${byCat[c].n}  /  ${byCat[c].misroute}  /  ${byCat[c].method}`);

// misroute detail: which pred->true confusions cost questions
console.log(`\nmisroute-recoverable detail (true -> pred : method em<-om):`);
for (const r of misrouteRecoverable) console.log(`  ${r.id}  ${r.tc} routed-as ${r.pc}  (${r.om}->${r.em})`);

// (B) label-free lever counterfactuals — reuse EXISTING judgments only
console.log(`\n=== (B) label-free lever counterfactuals (existing judgments; no new spend) ===`);
// helper: score a routing function label->method over all 500 using realized()
const scoreRoute = (methodOf) => rows.reduce((s, r) => s + (realized(r.id, methodOf(r)).ok ? 1 : 0), 0);

// B1: perfect classifier (oracle route, base method set) = ceiling of classifier-only improvement
console.log(`B1 perfect classifier (oracle route)      : ${microO}/500  (+${microO - microE})`);

// B2: uniform vh5 on all predicted non-SS (MS/TR/KU), h3 on SSU/SSP, qd on SSA — needs only SS-vs-nonSS + coarse buckets
const vh5Avail = (id) => vh5J.has(id);
const b2 = scoreRoute((r) => {
  const p = r.pc;
  if (p === 'single-session-assistant') return 'qd';
  if (p === 'single-session-user' || p === 'single-session-preference') return 'h3';
  return 'vh5'; // MS, TR, KU all -> vh5
});
console.log(`B2 KU->vh5 too (pred MS/TR/KU->vh5)        : ${b2}/500  (+${b2 - microE})   [needs vh5 answers for pred-KU]`);

// B3: how many pred-KU instances even have a vh5 judgment (else qd fallback, = no change)
const predKU = rows.filter((r) => r.pc === 'knowledge-update');
const predKUvh5 = predKU.filter((r) => vh5J.has(r.id));
console.log(`   pred-KU count=${predKU.length}, of which have vh5 answer=${predKUvh5.length} (rest = qd fallback = unchanged)`);

// B4: vh5 variant swaps on the vh5-routed cells (vh5L / vh5b / vh5g5) — pure method upgrade, label-free
for (const v of ['vh5L', 'vh5b', 'vh5g5']) {
  const vR = jrec(`official-answers-sample-500-gpt-5-mini-obs-qd-${v}-by-gpt-4o.jsonl`);
  const vg5R = v === 'vh5g5' ? jrec('official-answers-sample-500-gpt-5-obs-qd-vh5g5-by-gpt-4o.jsonl') : null;
  const alt = new Map([...bool(vR)]);
  if (vg5R) for (const [k, val] of bool(vg5R)) alt.set(k, val);
  const b = rows.reduce((s, r) => {
    let m = r.em;
    if (m === 'vh5') { const ok = alt.has(r.id) ? alt.get(r.id) : (vh5J.has(r.id) ? vh5J.get(r.id) : qdJ.get(r.id)); return s + (ok ? 1 : 0); }
    return s + (realized(r.id, m).ok ? 1 : 0);
  }, 0);
  console.log(`B4 swap vh5-routed cells -> ${v.padEnd(6)}         : ${b}/500  (+${b - microE})  [cover=${alt.size}]`);
}

// B5: decomp / esc / fullctx / ms24 / msraw24 overlays on their target cells (label-free method upgrades)
const covScore = (file, applyIf) => {
  const alt = bool(jrec(file));
  const b = rows.reduce((s, r) => {
    if (applyIf(r) && alt.has(r.id)) return s + (alt.get(r.id) ? 1 : 0);
    return s + (realized(r.id, r.em).ok ? 1 : 0);
  }, 0);
  return { b, cover: alt.size };
};
const msLike = (r) => r.em === 'vh5';
for (const [file, tag] of [
  ['official-answers-sample-500-gpt-5-mini-obs-qd-ms24-by-gpt-4o.jsonl', 'ms24 on vh5-routed'],
  ['official-answers-sample-500-gpt-5-mini-obs-qd-msraw24-by-gpt-4o.jsonl', 'msraw24 on vh5-routed'],
  ['official-answers-sample-500-gpt-5-mini-obs-qd-esc-by-gpt-4o.jsonl', 'esc(idk-escalate) on vh5-routed'],
  ['official-answers-sample-500-gpt-5-mini-obs-qd-decomp-by-gpt-4o.jsonl', 'decomp on vh5-routed'],
]) {
  const { b, cover } = covScore(file, msLike);
  console.log(`B5 ${tag.padEnd(34)}: ${b}/500  (+${b - microE})  [cover=${cover}]`);
}

// dump wrong-instance detail (answer vs gold) for judge/format inspection
const dump = wrong.map((r) => ({ id: r.id, true: r.tc, pred: r.pc, em: r.em, om: r.om, e_ok: r.e_ok, o_ok: r.o_ok, e_src: r.e_src, class: (r.em !== r.om && r.o_ok) ? 'misroute' : 'method', gold: r.e_rec?.gold, answer: r.e_rec?.answer }));
writeFileSync(resolve(D, 'e1b-miss-detail.json'), JSON.stringify(dump, null, 2) + '\n');
console.log(`\nwrote data/e1b-miss-detail.json (${dump.length} wrong rows)`);

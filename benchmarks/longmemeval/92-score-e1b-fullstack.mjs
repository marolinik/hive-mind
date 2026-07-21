// E1b full-stack EXACT — classifier-routed vs oracle-routed under the SAME per-category
// method set, all cells exact (recomputed where needed).
//
// Method by category (frozen, published stack, BASE methods only):
//   {single-session-assistant, knowledge-update} -> qd
//   {single-session-user, single-session-preference} -> h3 (full-log hybrid)
//   {temporal-reasoning, multi-session} -> vh5 (full-log 5-vote)
// Overlays pfc/klc are OMITTED from BOTH arms symmetrically (klc is not computable
// per-predicted category without building new ledgers for the 30 non-MS predicted-MS
// instances; to keep one clean base-methods definition applied identically to both
// arms, both overlays are dropped). Published SOTA WITH overlays = 93.60/95.01 oracle.
//
// Answer sources per method (union of published + E1b recomputed artifacts):
//   qd  : official ...-qd (all 500)
//   h3  : official ...-{h3t,h3p,h3u,h3k}  ∪  recomputed ...-fsh3
//   vh5 : official ...-vh5                 ∪  recomputed ...-fsvh5
//   any instance still lacking its routed-method answer (no cached mind) -> qd fallback
//   (applied identically in both arms; matches the published h3u qd-fallback convention).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const D = resolve(__dirname, 'data');
const load = (p) => existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const jmap = (f) => new Map(load(resolve(D, 'judgments', f)).filter((r) => !r.error).map((r) => [r.instance_id, !!r.correct]));

const CATS = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'multi-session', 'knowledge-update', 'temporal-reasoning'];
const METHOD = { 'single-session-assistant': 'qd', 'knowledge-update': 'qd', 'single-session-user': 'h3', 'single-session-preference': 'h3', 'temporal-reasoning': 'vh5', 'multi-session': 'vh5' };

const sample = load(resolve(D, 'sample-500.jsonl'));
const trueCat = new Map(sample.map((it) => [it.instance_id, it.question_type]));
const predCat = new Map(load(resolve(D, 'e1b-classpreds.jsonl')).map((r) => [r.instance_id, r.pred]));

const qdJ = jmap('official-answers-sample-500-gpt-5-mini-obs-qd-by-gpt-4o.jsonl');
const h3J = new Map();
for (const f of ['h3t', 'h3p', 'h3u', 'h3k']) for (const [k, v] of jmap(`official-answers-sample-500-gpt-5-mini-obs-qd-${f}-by-gpt-4o.jsonl`)) h3J.set(k, v);
for (const [k, v] of jmap('official-answers-sample-e1bfsh3-gpt-5-mini-obs-qd-fsh3-by-gpt-4o.jsonl')) h3J.set(k, v);
const vh5J = jmap('official-answers-sample-500-gpt-5-mini-obs-qd-vh5-by-gpt-4o.jsonl');
for (const [k, v] of jmap('official-answers-sample-e1bfsvh5-gpt-5-mini-obs-qd-fsvh5-by-gpt-4o.jsonl')) vh5J.set(k, v);

function realized(id, method) {
  if (method === 'qd') return qdJ.get(id);
  if (method === 'h3') return h3J.has(id) ? h3J.get(id) : { fb: qdJ.get(id) };
  if (method === 'vh5') return vh5J.has(id) ? vh5J.get(id) : { fb: qdJ.get(id) };
}
function score(labelOf) {
  const per = {}; let n = 0, c = 0, fb = 0;
  for (const it of sample) {
    const t = it.question_type; const m = METHOD[labelOf(it.instance_id)];
    let r = realized(it.instance_id, m); let ok;
    if (r && typeof r === 'object' && 'fb' in r) { fb++; ok = r.fb; } else ok = r;
    (per[t] ??= { n: 0, c: 0 }); per[t].n++; n++; if (ok) { per[t].c++; c++; }
  }
  const cats = CATS.filter((k) => per[k]);
  const macro = cats.reduce((s, k) => s + per[k].c / per[k].n, 0) / cats.length;
  return { n, c, micro: +(100 * c / n).toFixed(2), macro: +(100 * macro).toFixed(2), per, fb };
}

const oracle = score((id) => trueCat.get(id));
const e1b = score((id) => predCat.get(id));
const sixAcc = +(100 * sample.filter((it) => predCat.get(it.instance_id) === it.question_type).length / sample.length).toFixed(2);
const pathAcc = +(100 * sample.filter((it) => METHOD[predCat.get(it.instance_id)] === METHOD[it.question_type]).length / sample.length).toFixed(2);

const pc = (r) => CATS.filter((k) => r.per[k]).map((k) => `${k}:${(100 * r.per[k].c / r.per[k].n).toFixed(1)}`).join('  ');
console.log('=== E1b FULL-STACK EXACT (base methods qd/h3/vh5; pfc/klc omitted both arms) ===\n');
console.log(`6-way classifier accuracy : ${sixAcc}%`);
console.log(`method-route accuracy     : ${pathAcc}%  (qd/h3/vh5 bucket)\n`);
console.log(`oracle-routed (by TRUE)   : ${oracle.micro} micro / ${oracle.macro} macro  (${oracle.c}/${oracle.n})   qd-fallbacks=${oracle.fb}`);
console.log(`E1b classifier-routed     : ${e1b.micro} micro / ${e1b.macro} macro  (${e1b.c}/${e1b.n})   qd-fallbacks=${e1b.fb}`);
console.log(`delta (E1b - oracle)      : ${(e1b.micro - oracle.micro).toFixed(2)} micro / ${(e1b.macro - oracle.macro).toFixed(2)} macro`);
console.log(`\noracle per-cat: ${pc(oracle)}`);
console.log(`E1b    per-cat: ${pc(e1b)}`);
console.log('\n=== comparison row ===');
console.log(`uniform all-qd (E1)                 : 88.20 / 89.79`);
console.log(`E1b classifier-routed (base)        : ${e1b.micro} / ${e1b.macro}`);
console.log(`oracle-routed (base, this run)      : ${oracle.micro} / ${oracle.macro}`);
console.log(`oracle-routed + pfc/klc/h3u (pub)   : 93.60 / 95.01`);
console.log(`Mastra                              : 93.60 / 94.87`);

const out = {
  experiment: 'E1b-fullstack-exact',
  method_set: METHOD,
  overlays: 'pfc/klc omitted from BOTH arms (klc not computable per-predicted without new ledgers); published-with-overlays oracle = 93.60/95.01',
  recomputed: { h3_fsh3: 'answers-sample-e1bfsh3 (35 requested)', vh5_fsvh5: 'answers-sample-e1bfsvh5 (51 requested)' },
  classifier: { six_way_accuracy_pct: sixAcc, method_route_accuracy_pct: pathAcc },
  oracle_routed_base: { micro: oracle.micro, macro: oracle.macro, correct: `${oracle.c}/${oracle.n}`, qd_fallbacks: oracle.fb, per_category: oracle.per },
  e1b_classifier_routed_base: { micro: e1b.micro, macro: e1b.macro, correct: `${e1b.c}/${e1b.n}`, qd_fallbacks: e1b.fb, per_category: e1b.per },
  delta_e1b_minus_oracle: { micro: +(e1b.micro - oracle.micro).toFixed(2), macro: +(e1b.macro - oracle.macro).toFixed(2) },
  references: { uniform_all_qd: { micro: 88.20, macro: 89.79 }, published_oracle_full: { micro: 93.60, macro: 95.01 }, mastra: { micro: 93.60, macro: 94.87 } },
};
writeFileSync(resolve(D, 'results-e1b-fullstack.json'), JSON.stringify(out, null, 2) + '\n');
console.log('\nwrote data/results-e1b-fullstack.json');

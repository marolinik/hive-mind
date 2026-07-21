// E1 no-oracle rerun scoring — Arm A = uniform `qd` read policy applied to ALL
// 500 questions with NO question_type routing. Scores the already-cached, already
// -judged uniform qd run (36-reanswer-qd.mjs + 30b-judge-official.mjs) without the
// per-category composition of 42-compose-final.mjs. No API spend: pure re-score.
//
// Emits NEW files suffixed -e1-uniform; never overwrites existing results.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const D = resolve(__dirname, 'data');
const load = (p) => existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const sample = load(resolve(D, 'sample-500.jsonl'));
const jQd = load(resolve(D, 'judgments/official-answers-sample-500-gpt-5-mini-obs-qd-by-gpt-4o.jsonl'));
const aQd = load(resolve(D, 'answers/answers-sample-500-gpt-5-mini-obs-qd.jsonl'));
const mJ = new Map(jQd.filter((r) => !r.error).map((r) => [r.instance_id, r]));
const mA = new Map(aQd.filter((r) => !r.error).map((r) => [r.instance_id, r]));

const CATS = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'temporal-reasoning', 'knowledge-update', 'multi-session'];

function tally(items, pred) {
  const by = {}; let n = 0, c = 0;
  for (const it of items) {
    const j = mJ.get(it.instance_id);
    if (!j) { console.error('MISSING judgment', it.instance_id); continue; }
    if (pred && !pred(it, j)) continue;
    (by[it.question_type] ??= { n: 0, c: 0 });
    by[it.question_type].n++; n++;
    if (j.correct) { by[it.question_type].c++; c++; }
  }
  return { by, n, c };
}

function report(label, items, pred) {
  const { by, n, c } = tally(items, pred);
  const cats = CATS.filter((k) => by[k]);
  const macro = cats.reduce((s, k) => s + by[k].c / by[k].n, 0) / cats.length;
  console.log(`\n=== ${label} ===`);
  console.log(`category                          acc%      n`);
  for (const k of cats) {
    const { n: cn, c: cc } = by[k];
    console.log(`${k.padEnd(32)} ${(100 * cc / cn).toFixed(1).padStart(6)}   ${String(cn).padStart(4)}`);
  }
  console.log(`MICRO  : ${(100 * c / n).toFixed(2)}%  (${c}/${n})`);
  console.log(`MACRO  : ${(100 * macro).toFixed(2)}%  (unweighted mean of ${cats.length} categories)`);
  return { by, n, c, macro };
}

// 1) Full 500 (abstention folded into its category, scored by official T_ABS judge)
const full = report('E1 Arm A — uniform qd, ALL 500 (official protocol: abstention scored by abstention judge)', sample);
// 2) Answerable-only view (470) and abstention-only view (30) for transparency
report('E1 Arm A — answerable only (470, is_abstention=false)', sample, (it) => !it.is_abstention);
report('E1 Arm A — abstention only (30, is_abstention=true)', sample, (it) => it.is_abstention);

// Comparison rows
console.log(`\n=== COMPARISON ===`);
console.log(`E1 Arm A (uniform qd, no routing) : ${(100 * full.c / full.n).toFixed(2)} micro / ${(100 * full.macro).toFixed(2)} macro  (${full.c}/${full.n})`);
console.log(`routed (42-compose-final, oracle) : 93.60 micro / 95.01 macro  (468/500)`);
console.log(`Mastra                            : ~94.87 macro            (~468/500)`);

// Emit uniform answers file (copy of qd answers, tagged) — NEW file, no overwrite
const outA = resolve(D, 'answers/answers-sample-500-gpt-5-mini-obs-qd-e1-uniform.jsonl');
const composed = sample.map((it) => {
  const a = mA.get(it.instance_id); const j = mJ.get(it.instance_id);
  return { ...(a ?? { instance_id: it.instance_id }), routed: 'qd-uniform', correct: j?.correct ?? null };
});
writeFileSync(outA, composed.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(`\nemitted ${composed.length} uniform answers -> ${outA}`);

// Emit score summary JSON — NEW file
const outS = resolve(D, 'results-e1-uniform.json');
const summary = {
  arm: 'A',
  definition: 'uniform qd read policy (36-reanswer-qd.mjs) applied to all 500, no question_type routing',
  answers_file: 'answers/answers-sample-500-gpt-5-mini-obs-qd.jsonl',
  judgment_file: 'judgments/official-answers-sample-500-gpt-5-mini-obs-qd-by-gpt-4o.jsonl',
  answerer: 'gpt-5-mini', judge: 'gpt-4o (official LongMemEval per-type prompts)',
  full_500: { micro_pct: +(100 * full.c / full.n).toFixed(2), micro: `${full.c}/${full.n}`, macro_pct: +(100 * full.macro).toFixed(2), per_category: full.by },
  routed_reference: { micro_pct: 93.60, macro_pct: 95.01, micro: '468/500' },
};
writeFileSync(outS, JSON.stringify(summary, null, 2) + '\n');
console.log(`emitted score summary -> ${outS}`);

#!/usr/bin/env node
/**
 * LoCoMo v5 trio-strict offline rescore.
 *
 * Re-derives the published benchmark headline (217/320 = 67.8% trio-strict,
 * 224/320 = 70.0% trio-majority) from the committed artifacts under
 * ./artifacts/ — with ZERO API calls. Pure file read + arithmetic.
 *
 * This is the regression baseline for the substrate's LoCoMo claim. It is
 * intentionally adversarial about its own inputs:
 *   1. Verifies each artifact's sha256 against artifacts/MANIFEST.json
 *      (tamper-evidence — a mutated artifact fails here, not silently).
 *   2. Independently recomputes the per-row trio verdict from the raw
 *      per-judge verdicts using the canonical rule, then cross-checks it
 *      against the stored `trio_strict` / `trio_majority` fields (proves the
 *      committed bookkeeping matches the scoring algorithm).
 *   3. Asserts the aggregate, per-category, and per-judge tallies match the
 *      manifest's `expected` block exactly.
 *
 * Exit 0 = every expected number reproduced. Exit 1 = mismatch.
 *
 * Portable: resolves paths relative to this file, no hardcoded roots.
 *
 * Canonical trio-strict rule: a row is CORRECT only when ALL THREE judges
 * (Opus 4.7, GPT-5.5, MiniMax M2.7) return CORRECT. A row where any judge
 * failed to parse is excluded (verdict null → counts as not-correct; the
 * denominator stays 320).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, 'artifacts');

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };

// ── 1. Load + integrity-check artifacts ──────────────────────────────────
const manifest = JSON.parse(readFileSync(join(ART, 'MANIFEST.json'), 'utf8'));

for (const [name, meta] of Object.entries(manifest.artifacts)) {
  const buf = readFileSync(join(ART, name));
  const sha = createHash('sha256').update(buf).digest('hex');
  ok(sha === meta.sha256,
    `sha256 mismatch for ${name}\n      expected ${meta.sha256}\n      actual   ${sha}`);
}

const rows = readFileSync(join(ART, 'trio-judgments-v5-retrieval.v2.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));

// ── 2. Recompute per-row verdict (canonical rule) + cross-check stored ────
let strictCount = 0;
let majorityCount = 0;
let parseFailures = 0;
let mismatchStrict = 0;
let mismatchMajority = 0;
const perCategory = {};                       // label -> { correct, total }
const perJudge = { opus: 0, gpt: 0, mm: 0 };

for (const r of rows) {
  const j = r.judges;
  const parsed = Boolean(j.opus.parsed && j.gpt.parsed && j.mm.parsed);

  let strict;
  let majority;
  if (!parsed) {
    strict = null;                            // excluded — counts as not-correct
    majority = null;
    parseFailures += 1;
  } else {
    const o = j.opus.verdict === 1;
    const g = j.gpt.verdict === 1;
    const m = j.mm.verdict === 1;
    strict = (o && g && m) ? 1 : 0;
    majority = ((o ? 1 : 0) + (g ? 1 : 0) + (m ? 1 : 0)) >= 2 ? 1 : 0;
  }

  // Cross-check our independent recompute against the committed fields.
  if (strict !== r.trio_strict) mismatchStrict += 1;
  if (majority !== r.trio_majority) mismatchMajority += 1;

  if (strict === 1) strictCount += 1;
  if (majority === 1) majorityCount += 1;

  // Per-judge correctness counts each judge independently (verdict === 1).
  if (j.opus.verdict === 1) perJudge.opus += 1;
  if (j.gpt.verdict === 1) perJudge.gpt += 1;
  if (j.mm.verdict === 1) perJudge.mm += 1;

  const cat = r.category_label;
  perCategory[cat] ??= { correct: 0, total: 0 };
  perCategory[cat].total += 1;
  if (strict === 1) perCategory[cat].correct += 1;
}

// ── 3. Assert against the manifest's expected block ───────────────────────
const exp = manifest.expected;
const n = rows.length;
const pct = (c) => Math.round((1000 * c) / n) / 10;

ok(n === exp.n, `row count ${n} !== expected ${exp.n}`);
ok(mismatchStrict === 0, `${mismatchStrict} rows: recomputed trio_strict != committed field`);
ok(mismatchMajority === 0, `${mismatchMajority} rows: recomputed trio_majority != committed field`);
ok(strictCount === exp.trio_strict.correct,
  `trio-strict ${strictCount} !== expected ${exp.trio_strict.correct}`);
ok(majorityCount === exp.trio_majority.correct,
  `trio-majority ${majorityCount} !== expected ${exp.trio_majority.correct}`);
ok(parseFailures === exp.parse_failures,
  `parse failures ${parseFailures} !== expected ${exp.parse_failures}`);

for (const [cat, [c, t]] of Object.entries(exp.per_category_strict)) {
  const got = perCategory[cat] ?? { correct: -1, total: -1 };
  ok(got.correct === c && got.total === t,
    `category ${cat}: got ${got.correct}/${got.total} !== expected ${c}/${t}`);
}
for (const [k, v] of Object.entries(exp.per_judge_correct)) {
  ok(perJudge[k] === v, `judge ${k}: got ${perJudge[k]} !== expected ${v}`);
}

// ── 4. Report ─────────────────────────────────────────────────────────────
const line = '─'.repeat(58);
console.log(`\n  LoCoMo v5 trio-strict rescore  (N=${n}, offline, zero API)`);
console.log(`  ${line}`);
console.log(`  Trio-strict (AND of 3)   ${strictCount}/${n} = ${pct(strictCount)}%   [expect ${exp.trio_strict.correct}/${exp.trio_strict.pct}%]`);
console.log(`  Trio-majority (>=2 of 3) ${majorityCount}/${n} = ${pct(majorityCount)}%   [expect ${exp.trio_majority.correct}/${exp.trio_majority.pct}%]`);
console.log(`  Parse failures           ${parseFailures}/${n}`);
console.log(`  ${line}`);
console.log('  Per-category (trio-strict):');
for (const cat of Object.keys(exp.per_category_strict)) {
  const g = perCategory[cat];
  console.log(`    ${cat.padEnd(12)} ${g.correct}/${g.total} = ${(100 * g.correct / g.total).toFixed(1)}%`);
}
console.log('  Per-judge correctness:');
for (const k of Object.keys(perJudge)) {
  console.log(`    ${k.padEnd(12)} ${perJudge[k]}/${n} = ${pct(perJudge[k])}%`);
}
console.log(`  ${line}`);

if (fail.length) {
  console.error(`\n  ❌ RESCORE FAILED — ${fail.length} mismatch(es):`);
  for (const f of fail) console.error(`    • ${f}`);
  console.error('');
  process.exit(1);
}
console.log('  ✅ All expected numbers reproduced from committed artifacts.\n');
process.exit(0);

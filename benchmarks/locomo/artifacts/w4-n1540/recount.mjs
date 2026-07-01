#!/usr/bin/env node
// Offline verification of the LoCoMo SOTA headline — ZERO API calls.
// Recounts the committed judgments and asserts the overall + per-category tallies
// match the report. This is the regression baseline: if the substrate or scoring
// changes, re-generate and update EXPECT. Run: `node recount.mjs`
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JF = resolve(__dirname, 'judgments-N1540.jsonl');

// Expected tallies — 7-lane W4, current substrate, fresh gpt-4.1-mini judge (2026-07-01).
const EXPECT = {
  overall:      [1332, 1540],
  'single-hop': [776, 841],
  'multi-hop':  [227, 282],
  temporal:     [262, 321],
  'open-ended': [67, 96],
};

const rows = readFileSync(JF, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
let n = 0, c = 0; const cat = {};
for (const r of rows) {
  n++; const cl = r.category_label || '?';
  (cat[cl] ??= [0, 0])[1]++;
  if (String(r.verdict).trim() === '1') { c++; cat[cl][0]++; }
}

const p0 = 0.8195, ph = c / n, z = (ph - p0) / Math.sqrt(p0 * (1 - p0) / n);
console.log(`overall ${c}/${n} = ${(100 * ph).toFixed(2)}%   z=${z.toFixed(2)} vs Memori 81.95% (+${(100 * (ph - p0)).toFixed(2)}pp)`);

let fail = false;
for (const [k, [ec, en]] of Object.entries(EXPECT)) {
  const got = k === 'overall' ? [c, n] : cat[k];
  if (!got || got[0] !== ec || got[1] !== en) {
    console.error(`  MISMATCH ${k}: got ${got ? got.join('/') : 'none'} expected ${ec}/${en}`);
    fail = true;
  } else {
    console.log(`  OK ${k.padEnd(11)} ${ec}/${en} = ${(100 * ec / en).toFixed(2)}%`);
  }
}
if (fail) { console.error('\nRECOUNT FAILED'); process.exit(1); }
console.log('\nRECOUNT OK — committed judgments reproduce 86.49%.');

#!/usr/bin/env node
// Phase 24 — Apples-to-apples report (gpt-4o-mini subject + Mem0 protocol judge)
//
// The publishable headline. Reads mem0-judgments-gpt4o.jsonl (N=320, gpt-4o-mini
// subject + gpt-4o-mini judge with Mem0's verbatim prompt) and emits a side-by-
// side comparison table against Mem0 paper Table 1/2.
//
// This is the cleanest comparison: same subject model, same judge model,
// same judge prompt, same per-category averaging — only the substrate differs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');

function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function pct(n, d) { return d > 0 ? `${(100 * n / d).toFixed(2)}%` : 'n/a'; }

function aggregate(rows) {
  const byCellCat = new Map();
  for (const r of rows) {
    const key = `${r.cell}|${r.category_label}`;
    if (!byCellCat.has(key)) byCellCat.set(key, { n: 0, correct: 0 });
    const b = byCellCat.get(key);
    b.n++;
    if (r.verdict === 1) b.correct++;
  }
  return byCellCat;
}

function totals(byCellCat, cell) {
  let n = 0, c = 0;
  for (const [k, v] of byCellCat) {
    if (!k.startsWith(`${cell}|`)) continue;
    n += v.n; c += v.correct;
  }
  return { n, c };
}

function main() {
  const mem0gpt4o = readJsonl(resolve(DATA_DIR, 'judgments', 'mem0-judgments-gpt4o.jsonl'));
  const mem0qwen = readJsonl(resolve(DATA_DIR, 'judgments', 'mem0-judgments.jsonl'));

  if (mem0gpt4o.length === 0) throw new Error('No gpt-4o-mini mem0 judgments — run 23 first');

  const g = aggregate(mem0gpt4o);
  const q = aggregate(mem0qwen);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const lines = [];
  lines.push(`# LoCoMo Apples-to-Apples — ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`**The headline measurement.** Same subject model (gpt-4o-mini), same judge model (gpt-4o-mini), same verbatim Mem0 "be generous" prompt, same per-category averaging. Only the substrate (post-Phase-3 hive-mind) differs from Mem0's published protocol.`);
  lines.push('');
  lines.push(`Source for Mem0 numbers: arxiv:2504.19413 Table 1.`);
  lines.push(`Sample: N=80 per category, 4-way stratified (multi-hop / temporal / open-ended / single-hop), seed=42, total N=320 per cell.`);
  lines.push('');
  lines.push(`## Headline — apples-to-apples vs Mem0 paper`);
  lines.push('');
  const mem0Paper = { 'single-hop': 67.13, 'multi-hop': 51.15, 'open-ended': 72.93, 'temporal': 55.51 };
  const mem0gPaper = { 'single-hop': 65.71, 'multi-hop': 47.19, 'open-ended': 75.71, 'temporal': 58.13 };

  lines.push(`| Category | Mem0 base (paper) | Mem0^g graph (paper) | **Our retrieval** (gpt-4o-mini subj) | Δ vs Mem0 base | **Our oracle** (gpt-4o-mini subj) |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const cat of ['single-hop', 'multi-hop', 'open-ended', 'temporal']) {
    const oG = g.get(`oracle|${cat}`) ?? { n: 0, correct: 0 };
    const rG = g.get(`retrieval|${cat}`) ?? { n: 0, correct: 0 };
    const rPct = rG.n > 0 ? 100 * rG.correct / rG.n : 0;
    const oPct = oG.n > 0 ? 100 * oG.correct / oG.n : 0;
    const dRet = rPct - mem0Paper[cat];
    lines.push(`| ${cat} | ${mem0Paper[cat]} | ${mem0gPaper[cat]} | **${pct(rG.correct, rG.n)}** (${rG.correct}/${rG.n}) | ${dRet >= 0 ? '+' : ''}${dRet.toFixed(2)}pp | ${pct(oG.correct, oG.n)} (${oG.correct}/${oG.n}) |`);
  }
  const oTotG = totals(g, 'oracle');
  const rTotG = totals(g, 'retrieval');
  const oTotPct = 100 * oTotG.c / oTotG.n;
  const rTotPct = 100 * rTotG.c / rTotG.n;
  const dRet = rTotPct - 66.88;
  lines.push(`| **Overall J** | **66.88** | **68.44** | **${pct(rTotG.c, rTotG.n)}** | **${dRet >= 0 ? '+' : ''}${dRet.toFixed(2)}pp** | **${pct(oTotG.c, oTotG.n)}** |`);
  lines.push('');

  // Sub-3pp resolution: ±5.5pp 95% CI on a binomial with N=320 (large enough for the headline)
  // Per-category N=80 → ±10.9pp 95% CI worst-case. Worth flagging.
  lines.push(`### Statistical context`);
  lines.push('');
  lines.push(`- Overall N=${rTotG.n} per cell. Binomial 95% CI on the retrieval cell: ±~5.5pp around ${pct(rTotG.c, rTotG.n)}.`);
  lines.push(`- Per-category N=${(rTotG.n / 4).toFixed(0)}. Binomial 95% CI: ±~11pp on each per-category cell. Per-category gaps below ~10pp should be treated as noise.`);
  lines.push(`- Mem0 paper reports overall J at ±0.15pp (their N=1540) — **their CIs are tighter than ours**. Direct numerical comparisons need this disclosed.`);
  lines.push('');

  // Compare with the Qwen-subject N=80 numbers (existing run)
  if (mem0qwen.length > 0) {
    const oTotQ = totals(q, 'oracle');
    const rTotQ = totals(q, 'retrieval');
    lines.push(`## Subject-model ablation (same substrate, same judge, different subject)`);
    lines.push('');
    lines.push(`| Subject | Sample | Oracle J | Retrieval J |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| **Qwen3.6-35B-A3B (thinking=ON)** | N=80 | ${pct(oTotQ.c, oTotQ.n)} | ${pct(rTotQ.c, rTotQ.n)} |`);
    lines.push(`| **gpt-4o-mini (Mem0-equivalent)** | N=320 | ${pct(oTotG.c, oTotG.n)} | ${pct(rTotG.c, rTotG.n)} |`);
    lines.push('');
    lines.push(`A useful diagnostic: if gpt-4o-mini outperforms Qwen-thinking-ON on identical substrate retrieval, the substrate is the constraint, not the subject. If Qwen outperforms, the subject capability is dominating. The number to read is the **gpt-4o-mini retrieval** vs Mem0's published 66.88% — that's the apples-to-apples claim.`);
    lines.push('');
  }

  lines.push(`## Per-cell breakdown (gpt-4o-mini, N=320)`);
  lines.push('');
  lines.push(`### Oracle (full conv context — substrate-quality ceiling)`);
  lines.push(`Total: ${pct(oTotG.c, oTotG.n)} (${oTotG.c}/${oTotG.n})`);
  lines.push('');
  lines.push(`### Retrieval (top-5 substrate chunks — apples-to-apples)`);
  lines.push(`Total: ${pct(rTotG.c, rTotG.n)} (${rTotG.c}/${rTotG.n})`);
  lines.push('');

  lines.push(`---`);
  lines.push(`Files: \`scripts/locomo/data/answers/cell-{oracle,retrieval}-gpt4o.jsonl\`, \`scripts/locomo/data/judgments/mem0-judgments-gpt4o.jsonl\``);
  lines.push(`Methodology: \`MEM0-METHODOLOGY.md\` in project root.`);

  const out = resolve(DATA_DIR, '..', '..', `RESULT-apples-${ts}.md`);
  writeFileSync(out, lines.join('\n'));
  console.log(`[report] written → ${out}`);
  console.log('');
  console.log(`Headline (gpt-4o-mini subject + judge, Mem0 protocol):`);
  console.log(`  Oracle    : ${pct(oTotG.c, oTotG.n)}`);
  console.log(`  Retrieval : ${pct(rTotG.c, rTotG.n)}  (Mem0 paper: 66.88%, Δ = ${(100*rTotG.c/rTotG.n - 66.88).toFixed(2)}pp)`);
}

main();

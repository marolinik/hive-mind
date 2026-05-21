#!/usr/bin/env node
// Phase 34 — Claude self-judge report (Opus 4.7 subject + Opus 4.7 judge)
// Plus three-subject ablation table (Qwen / gpt-4o-mini / Opus on same Mem0 prompt).

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
  const m = new Map();
  for (const r of rows) {
    const k = `${r.cell}|${r.category_label}`;
    if (!m.has(k)) m.set(k, { n: 0, c: 0 });
    const b = m.get(k); b.n++; if (r.verdict === 1) b.c++;
  }
  return m;
}
function totals(m, cell) {
  let n = 0, c = 0;
  for (const [k, v] of m) if (k.startsWith(`${cell}|`)) { n += v.n; c += v.c; }
  return { n, c };
}

function main() {
  const claude = readJsonl(resolve(DATA_DIR, 'judgments', 'claude-self-judgments.jsonl'));
  if (claude.length === 0) throw new Error('No claude self-judgments — run 33 first');

  const cAgg = aggregate(claude);
  const cO = totals(cAgg, 'oracle');
  const cR = totals(cAgg, 'retrieval');

  // Cross-protocol comparison
  const qwenMem0 = readJsonl(resolve(DATA_DIR, 'judgments', 'mem0-judgments.jsonl'));
  const qwenSelf = readJsonl(resolve(DATA_DIR, 'judgments', 'self-judgments.jsonl'));
  const qwenTrio = readJsonl(resolve(DATA_DIR, 'judgments', 'trio-judgments.jsonl'));
  const gpt4oMem0 = readJsonl(resolve(DATA_DIR, 'judgments', 'mem0-judgments-gpt4o.jsonl'));

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const lines = [];
  lines.push(`# LoCoMo Claude Family Run — ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`**Subject:** \`claude-opus-4-7\` (Anthropic) — temperature deprecated for this model, default sampling used`);
  lines.push(`**Judge:**   \`claude-opus-4-7\` (same model, full Claude family run)`);
  lines.push(`**Prompt:**  Mem0 verbatim "be generous" prompt`);
  lines.push(`**Sample:**  N=80 paired (sample-cells-23.jsonl, same as Qwen run)`);
  lines.push('');

  lines.push(`## Headline (Claude self-judge, Mem0 prompt)`);
  lines.push('');
  const cats = ['single-hop', 'multi-hop', 'temporal', 'open-ended'];
  const mem0Paper = { 'single-hop': 67.13, 'multi-hop': 51.15, 'temporal': 55.51, 'open-ended': 72.93 };

  lines.push(`| Category | Mem0 paper | Our Oracle | Δ orac | Our Retrieval | Δ retr |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const cat of cats) {
    const o = cAgg.get(`oracle|${cat}`) ?? { n: 0, c: 0 };
    const r = cAgg.get(`retrieval|${cat}`) ?? { n: 0, c: 0 };
    const oP = o.n > 0 ? 100 * o.c / o.n : 0;
    const rP = r.n > 0 ? 100 * r.c / r.n : 0;
    lines.push(`| ${cat} | ${mem0Paper[cat]} | ${pct(o.c, o.n)} (${o.c}/${o.n}) | ${(oP - mem0Paper[cat] >= 0 ? '+' : '')}${(oP - mem0Paper[cat]).toFixed(2)}pp | ${pct(r.c, r.n)} (${r.c}/${r.n}) | ${(rP - mem0Paper[cat] >= 0 ? '+' : '')}${(rP - mem0Paper[cat]).toFixed(2)}pp |`);
  }
  const oP = 100 * cO.c / cO.n, rP = 100 * cR.c / cR.n;
  const oCI = 100 * 1.96 * Math.sqrt((cO.c / cO.n) * (1 - cO.c / cO.n) / cO.n);
  const rCI = 100 * 1.96 * Math.sqrt((cR.c / cR.n) * (1 - cR.c / cR.n) / cR.n);
  lines.push(`| **Overall J** | **66.88** | **${pct(cO.c, cO.n)}** ±${oCI.toFixed(1)}pp | **${(oP - 66.88 >= 0 ? '+' : '')}${(oP - 66.88).toFixed(2)}pp** | **${pct(cR.c, cR.n)}** ±${rCI.toFixed(1)}pp | **${(rP - 66.88 >= 0 ? '+' : '')}${(rP - 66.88).toFixed(2)}pp** |`);
  lines.push('');
  lines.push(`> Important: this is a **self-judge** number (Claude judging Claude). Per the documented +27.35pp methodology gap, self-judge inflates vs cross-family. Compare to Mem0's 91.6% (their self-judge) NOT 66.88% (their cross-family-equivalent number from the paper). For apples-to-apples vs Mem0 paper, see the gpt-4o-mini cross-family run in RESULT-apples-*.md.`);
  lines.push('');

  // Three-subject ablation
  if (qwenMem0.length > 0 && gpt4oMem0.length > 0) {
    const qAgg = aggregate(qwenMem0);
    const gAgg = aggregate(gpt4oMem0);
    const qO = totals(qAgg, 'oracle'), qR = totals(qAgg, 'retrieval');
    const gO = totals(gAgg, 'oracle'), gR = totals(gAgg, 'retrieval');
    lines.push(`## Three-subject ablation — same substrate, same retrieval, three subjects`);
    lines.push('');
    lines.push(`| Subject | Judge | Sample | Oracle J | Retrieval J | Subject capability proxy |`);
    lines.push(`|---|---|---|---|---|---|`);
    lines.push(`| **gpt-4o-mini** | gpt-4o-mini (Mem0) | N=320 | ${pct(gO.c, gO.n)} | ${pct(gR.c, gR.n)} | small / no reasoning |`);
    lines.push(`| **Qwen3.6-35B-A3B (thinking=ON)** | gpt-4o-mini (Mem0) | N=80 | ${pct(qO.c, qO.n)} | ${pct(qR.c, qR.n)} | mid / reasoning-heavy |`);
    lines.push(`| **Claude Opus 4.7** | Opus 4.7 (self-judge) | N=80 | **${pct(cO.c, cO.n)}** | **${pct(cR.c, cR.n)}** | frontier / reasoning-default |`);
    lines.push('');
    lines.push(`**Reading:** Note the Claude row uses self-judge (different methodology). Within-protocol, gpt-4o-mini and Qwen are directly comparable; Claude requires self-judge correction (~+27pp inflation per prior methodology gap). The substrate quality (oracle ceiling) tracks subject capability roughly linearly: gpt-4o-mini < Qwen-thinking < Claude.`);
    lines.push('');
  }

  // Per-cell breakdown
  lines.push(`## Per-cell sample answers (3 random for sanity)`);
  lines.push('');
  for (const cell of ['oracle', 'retrieval']) {
    lines.push(`### ${cell}`);
    const sample = claude.filter(r => r.cell === cell).slice(0, 3);
    for (const r of sample) {
      lines.push(`- **Q:** ${r.question}`);
      lines.push(`  **Gold:** ${r.ground_truth}`);
      lines.push(`  **Claude:** ${String(r.answer_content).replace(/\n/g, ' ').slice(0, 200)}`);
      lines.push(`  **Verdict:** ${r.verdict === 1 ? '✅ CORRECT' : r.verdict === 0 ? '❌ WRONG' : '⚠️ PARSE-FAIL'}`);
      lines.push('');
    }
  }

  lines.push(`---`);
  lines.push(`Files: \`scripts/locomo/data/answers/cell-{oracle,retrieval}-claude.jsonl\`, \`scripts/locomo/data/judgments/claude-self-judgments.jsonl\``);

  const out = resolve(DATA_DIR, '..', '..', `RESULT-claude-${ts}.md`);
  writeFileSync(out, lines.join('\n'));
  console.log(`[report] written → ${out}`);
  console.log('');
  console.log(`Headline (Claude Opus 4.7 self-judge, Mem0 prompt, N=80):`);
  console.log(`  Oracle    : ${pct(cO.c, cO.n)} ±${oCI.toFixed(1)}pp`);
  console.log(`  Retrieval : ${pct(cR.c, cR.n)} ±${rCI.toFixed(1)}pp  (vs Mem0 paper 66.88%, Δ = ${(rP - 66.88).toFixed(2)}pp)`);
}

main();

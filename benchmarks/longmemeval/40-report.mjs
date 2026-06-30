#!/usr/bin/env node
// LongMemEval — aggregate a judgments file into overall + per-type accuracy.
//
// Usage: node 40-report.mjs --judged data/judgments/judged-...jsonl

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}

const JUDGED = resolve(process.cwd(), arg('judged', ''));

function main() {
  if (!JUDGED || !existsSync(JUDGED)) throw new Error(`pass --judged <file>`);
  const rows = readFileSync(JUDGED, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !r.error);
  const byType = {};
  let nCorrect = 0;
  for (const r of rows) {
    byType[r.question_type] ??= { n: 0, c: 0 };
    byType[r.question_type].n++;
    if (r.correct) { byType[r.question_type].c++; nCorrect++; }
  }
  const overall = rows.length ? (100 * nCorrect / rows.length) : 0;
  console.log(`\n=== LongMemEval report: ${JUDGED.split(/[\\/]/).pop()} ===`);
  console.log(`N = ${rows.length}`);
  console.log('');
  console.log('question_type'.padEnd(28), 'n'.padStart(5), 'acc%'.padStart(8));
  console.log('-'.repeat(43));
  for (const [t, s] of Object.entries(byType).sort()) {
    console.log(t.padEnd(28), String(s.n).padStart(5), (100 * s.c / s.n).toFixed(1).padStart(8));
  }
  console.log('-'.repeat(43));
  console.log('OVERALL'.padEnd(28), String(rows.length).padStart(5), overall.toFixed(2).padStart(8));
}

main();

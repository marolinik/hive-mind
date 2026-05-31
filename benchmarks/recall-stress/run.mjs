#!/usr/bin/env node
/**
 * Recall stress test — a precision@3 regression gate for hive-mind recall.
 *
 * Runs a set of queries against `recall_memory` (via the built CLI), scores the
 * top-3 results against expected substrings, prints a table, and exits non-zero
 * if the run is too slow (>60s) or average precision falls below a threshold.
 *
 * Portable port of `.harvest/stress-test.cjs`. Changes on lift:
 *   - Queries are PARAMETERIZED (a JSON file), not hardcoded — the original
 *     embedded one operator's personal/proprietary corpus. Supply your own:
 *       node run.mjs --queries ./queries.local.json
 *     (queries.local.json is gitignored; queries.example.json ships as a
 *     neutral template.)
 *   - Repo root resolves via HIVE_MIND_ROOT ?? <repo root> (no hardcoded D:/).
 *
 * Usage:
 *   node benchmarks/recall-stress/run.mjs [--queries <path>] [--profile <p>]
 *        [--min-precision <0..1>] [--max-seconds <n>] [--out <path>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.HIVE_MIND_ROOT ?? resolve(HERE, '..', '..');
const CLI = process.env.HIVE_MIND_CLI ?? join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const queriesPath = arg('queries', join(HERE, 'queries.example.json'));
const profile = arg('profile', null);
const config = JSON.parse(readFileSync(queriesPath, 'utf8'));
const queries = config.queries ?? [];
const activeProfile = profile ?? config.profile ?? 'balanced';
const minPrecision = Number(arg('min-precision', config.minPrecision ?? 0.5));
const maxSeconds = Number(arg('max-seconds', 60));
const outPath = arg('out', null);

function callRecall(query) {
  // recall-context --json emits a structured { query, hits: [{id,content,importance,score}] }
  // envelope — the parseable path (mcp call recall_memory only prints formatted text).
  // Default NO_RERANK on: each query is a fresh process, so loading the ~87MB
  // reranker per query would blow the time gate. Operators can override.
  const r = spawnSync(
    'node',
    [CLI, 'recall-context', query, '--json', '--limit', '5', '--profile', activeProfile],
    {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HIVE_MIND_NO_RERANK: process.env.HIVE_MIND_NO_RERANK ?? '1' },
    },
  );
  // Tolerate leading log lines on stdout (the embedding probe logs to stdout
  // before the JSON envelope) by parsing from the first '{'.
  const out = r.stdout || '';
  const jsonStart = out.indexOf('{');
  if (jsonStart < 0) return { ok: false, results: [], raw: out };
  try {
    const parsed = JSON.parse(out.slice(jsonStart));
    return { ok: Array.isArray(parsed.hits), results: parsed.hits ?? [] };
  } catch (e) {
    return { ok: false, results: [], raw: out, err: e.message };
  }
}

function scoreResult(query, results) {
  const hits = results.slice(0, 3);
  if (!query.expect || query.expect.length === 0) {
    // Edge query: success = nothing scores as relevant.
    const maxScore = hits[0]?.score ?? 0;
    return { precision: maxScore < 0.02 ? 1 : 0, note: `edge — max score ${maxScore.toFixed(3)}` };
  }
  const matched = hits.filter((h) => {
    const text = (h.content || '').toLowerCase();
    return query.expect.some((needle) => text.includes(String(needle).toLowerCase()));
  });
  const precision = hits.length ? matched.length / hits.length : 0;
  return { precision, note: `${matched.length}/${hits.length} top-3 matched expected` };
}

const abbrev = (s, n = 100) => {
  const t = String(s || '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const t0 = Date.now();
const rows = [];
for (const q of queries) {
  const r = callRecall(q.q);
  if (!r.ok) {
    rows.push({ ...q, error: true });
    console.error(`ERROR  "${q.q}"`);
    continue;
  }
  const score = scoreResult(q, r.results);
  rows.push({ ...q, results: r.results, score });
  console.log(`${String(q.cat ?? '').padEnd(10)} prec=${score.precision.toFixed(2)}  "${abbrev(q.q, 50)}"  (${score.note})`);
}
const elapsedS = (Date.now() - t0) / 1000;

const valid = rows.filter((r) => !r.error);
const avgPrecision = valid.length ? valid.reduce((s, r) => s + r.score.precision, 0) / valid.length : 0;

// Markdown report (optional).
if (outPath) {
  const md = [
    '# hive-mind recall stress test',
    `_profile: ${activeProfile} · queries: ${queries.length} · avg precision@3: ${avgPrecision.toFixed(2)} · ${elapsedS.toFixed(1)}s_`,
    '',
    '| # | cat | query | precision@3 | note |',
    '|---|---|---|---|---|',
    ...rows.map((r, i) =>
      r.error
        ? `| ${i + 1} | ${r.cat ?? ''} | ${r.q} | ERROR | — |`
        : `| ${i + 1} | ${r.cat ?? ''} | ${r.q} | ${r.score.precision.toFixed(2)} | ${r.score.note} |`,
    ),
  ].join('\n');
  writeFileSync(outPath, md + '\n');
  console.log(`\nReport: ${outPath}`);
}

console.log(`\navg precision@3: ${avgPrecision.toFixed(2)} (min ${minPrecision})  ·  ${elapsedS.toFixed(1)}s (max ${maxSeconds}s)`);

// Regression gate.
const fail = [];
if (elapsedS > maxSeconds) fail.push(`too slow: ${elapsedS.toFixed(1)}s > ${maxSeconds}s`);
if (avgPrecision < minPrecision) fail.push(`precision ${avgPrecision.toFixed(2)} < ${minPrecision}`);
if (rows.some((r) => r.error)) fail.push('one or more queries errored');
if (fail.length) {
  console.error(`\n❌ recall-stress FAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\n✅ recall-stress passed.');

#!/usr/bin/env node
// Phase 4 — Run the LoCoMo query suite against the test workspace
//
// For each qa[] entry in the chosen conversation, call runRecallContext
// in single-workspace mode (scope='current' + workspace=<id> — the
// substrate primitive that prior session A1-A4 unlocked). Save one
// JSONL row per question with the question, reference answer, evidence
// dia_ids, category, and the top-5 retrieved hits. Phase 5 reads this
// JSONL and produces the LLM-judge verdict + recall@5 number.
//
// Design choices:
//   • Single CliEnv shared across all queries — pays the reranker load
//     cost once instead of 199 times.
//   • Append-only JSONL with resume-from-line-count so a mid-run crash
//     doesn't waste the queries already issued.
//   • Computes evidence_recall@5 inline (deterministic, free) and writes
//     it on each row — Phase 5 just averages.
//   • Reranker enabled (default behavior). Pass --no-rerank to disable
//     for ablation runs later.

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR_LOCAL = resolve(__dirname, 'data');
const RUN_FILE = resolve(DATA_DIR_LOCAL, 'RUN.json');
const DATASET_FILE = resolve(DATA_DIR_LOCAL, 'locomo10.json');
const OUT_DIR = resolve(DATA_DIR_LOCAL, 'queries');
const OUT_FILE = resolve(OUT_DIR, 'queries.jsonl');

const HIVE_MIND_ROOT = process.env.HIVE_MIND_ROOT ?? resolve(__dirname, '..', '..');
const SETUP_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/setup.js`).href;
const RECALL_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/commands/recall-context.js`).href;

function loadRun() {
  if (!existsSync(RUN_FILE)) throw new Error(`RUN.json missing — run 01-prepare-workspace.mjs first.`);
  return JSON.parse(readFileSync(RUN_FILE, 'utf8'));
}

function loadDataset(expectedSha) {
  if (!existsSync(DATASET_FILE)) throw new Error(`Dataset missing at ${DATASET_FILE}`);
  const buf = readFileSync(DATASET_FILE);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (expectedSha && sha !== expectedSha) {
    throw new Error(
      `Dataset SHA256 drift — RUN.json pinned ${expectedSha}, on-disk is ${sha}. ` +
      `Re-fetch and re-prepare.`,
    );
  }
  return JSON.parse(buf.toString('utf8'));
}

/** evidence_recall@5: did any retrieved snippet contain at least one evidence dia_id? */
function computeEvidenceRecall(retrieved, evidenceIds) {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) return null;
  for (const hit of retrieved) {
    const c = hit.content ?? '';
    for (const ev of evidenceIds) {
      // Match `dia:<ev>` literally — the prefix we wrote in Phase 2 ingest.
      if (c.includes(`dia:${ev}`)) return 1;
    }
  }
  return 0;
}

function countLines(path) {
  try {
    const sz = statSync(path).size;
    if (sz === 0) return 0;
    const txt = readFileSync(path, 'utf8');
    let n = 0;
    for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 10) n++;
    if (txt[txt.length - 1] !== '\n') n++; // last line without trailing newline
    return n;
  } catch { return 0; }
}

async function main() {
  const run = loadRun();
  const data = loadDataset(run.dataset_sha256);
  const convIdxArg = process.argv.find(a => a.startsWith('--conv-idx='));
  const convIdx = convIdxArg ? parseInt(convIdxArg.split('=')[1], 10) : run.conv_idx;
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 5;
  const noRerank = process.argv.includes('--no-rerank');
  const sliceArg = process.argv.find(a => a.startsWith('--slice='));
  const slice = sliceArg ? parseInt(sliceArg.split('=')[1], 10) : null; // for smoke runs

  if (convIdx < 0 || convIdx >= data.length) {
    throw new Error(`conv_idx ${convIdx} out of range`);
  }
  const conv = data[convIdx];
  const qas = conv.qa ?? [];
  const total = slice ? Math.min(slice, qas.length) : qas.length;

  // Resume-from-line-count: the JSONL is append-only, so we can pick up where
  // a prior crashed run left off without re-issuing those queries.
  const { mkdirSync } = await import('node:fs');
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const resumeFrom = countLines(OUT_FILE);

  const { openPersonalMind } = await import(SETUP_URL);
  const { runRecallContext } = await import(RECALL_URL);

  const env = openPersonalMind();
  console.log(`[query] workspace=${run.workspace} conv_idx=${convIdx} sample_id=${conv.sample_id}`);
  console.log(`        total qa=${qas.length}${slice ? ` (sliced to ${total})` : ''} | resume_from=${resumeFrom} | rerank=${!noRerank}`);

  // Warm the reranker once so per-query timings are honest. The first
  // getReranker() call downloads/loads the model (~22MB) — keeping that
  // off the first query's clock is just better diagnostics.
  console.log(`[warm] loading reranker...`);
  const t0warm = Date.now();
  await env.getReranker();
  console.log(`[warm] reranker ready in ${(Date.now() - t0warm) / 1000}s`);

  let recallSum = 0;
  let recallDenom = 0;
  let zeroHitCount = 0;
  const tStart = Date.now();

  try {
    for (let i = resumeFrom; i < total; i++) {
      const qa = qas[i];
      const t0 = Date.now();
      let row;
      try {
        const result = await runRecallContext({
          query: qa.question,
          scope: 'current',
          workspace: run.workspace,
          limit,
          profile: 'balanced',
          env,
          ...(noRerank && { rerank: false }),
        });
        const elapsed = Date.now() - t0;
        const recall = computeEvidenceRecall(result.hits, qa.evidence);
        if (recall !== null) { recallSum += recall; recallDenom++; }
        if (result.hits.length === 0) zeroHitCount++;

        row = {
          qa_idx: i,
          question: qa.question,
          answer: qa.answer,
          evidence: qa.evidence ?? [],
          category: String(qa.category ?? ''),
          retrieved: result.hits.map((h, rank) => ({
            rank: rank + 1,
            frame_id: h.id,
            score: h.score,
            from: h.from,
            content: h.content,
          })),
          evidence_recall_at5: recall,
          elapsed_ms: elapsed,
        };
      } catch (e) {
        row = {
          qa_idx: i, question: qa.question, error: String(e.message || e),
          elapsed_ms: Date.now() - t0,
        };
      }
      appendFileSync(OUT_FILE, JSON.stringify(row) + '\n');

      if ((i + 1) % 25 === 0 || i + 1 === total) {
        const dt = ((Date.now() - tStart) / 1000).toFixed(1);
        const r = recallDenom > 0 ? (recallSum / recallDenom).toFixed(3) : 'n/a';
        console.log(`        [${i + 1}/${total}] ${dt}s elapsed | recall@5=${r} | zero-hits=${zeroHitCount}`);
      }
    }
  } finally {
    env.close();
  }

  console.log(`[done] queries=${total - resumeFrom} new (out of ${total} total) | output=${OUT_FILE}`);
  if (recallDenom > 0) {
    console.log(`       evidence_recall@5 (this run) = ${(recallSum / recallDenom).toFixed(3)} over ${recallDenom} scorable Qs`);
  }
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

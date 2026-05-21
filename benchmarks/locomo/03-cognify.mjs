#!/usr/bin/env node
// Phase 3 — Populate the LoCoMo test workspace's retrieval indexes
//
// Two orthogonal substrate jobs are run here:
//
//   (a) MAINTENANCE rechunkAll — runs the semantic chunker over every frame
//       and writes chunk-level embeddings into memory_frame_chunks +
//       memory_frame_chunks_vec. This is the LOAD-BEARING step for Phase 4
//       retrieval — HybridSearch's chunk-level vec is what the reranker
//       re-scores. Without it, recall falls back to whole-frame vec / FTS
//       only and the post-Phase-3 substrate isn't being measured.
//
//   (b) COGNIFY (heuristic by default; LLM with --extract-llm) — fills the
//       knowledge graph (knowledge_entities, knowledge_relations). Useful
//       for KG/wiki layers but DOES NOT affect Phase 4 recall scoring,
//       so we default-off the slow path. Pass --extract-llm to enable a
//       claude -p-backed extraction pass for entity-quality measurement.
//
// Library mode. HIVE_MIND_NO_SYNTH defensive.

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_FILE = resolve(__dirname, 'data', 'RUN.json');

const HIVE_MIND_ROOT = 'D:/Projects/hive-mind';
const COGNIFY_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/commands/cognify.js`).href;
const MAINTENANCE_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/commands/maintenance.js`).href;

function loadRun() {
  if (!existsSync(RUN_FILE)) throw new Error(`RUN.json missing — run 01-prepare-workspace.mjs first.`);
  return JSON.parse(readFileSync(RUN_FILE, 'utf8'));
}

async function main() {
  const run = loadRun();
  const skipRechunk = process.argv.includes('--skip-rechunk');
  const extractLlm = process.argv.includes('--extract-llm');
  const skipExtract = process.argv.includes('--skip-extract');

  const { runCognify } = await import(COGNIFY_URL);
  const { runMaintenance } = await import(MAINTENANCE_URL);

  // -------- (a) chunker + chunk embeddings --------
  if (!skipRechunk) {
    console.log(`[rechunk] workspace=${run.workspace} (chunker + embedder)`);
    const t0 = Date.now();
    const r = await runMaintenance({ workspace: run.workspace, rechunkAll: true });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const rk = r.rechunkAll ?? {};
    console.log(`[rechunk done] ${dt}s`);
    console.log(`        framesProcessed : ${rk.framesProcessed ?? '?'}`);
    console.log(`        chunksCreated   : ${rk.chunksCreated ?? '?'}`);
    console.log(`        activeProvider  : ${rk.activeProvider ?? '?'}`);
    console.log(`        modelName       : ${rk.modelName ?? '?'}`);
  } else {
    console.log(`[rechunk] skipped (--skip-rechunk)`);
  }

  // -------- (b) entity extraction --------
  if (skipExtract) {
    console.log(`[cognify] skipped (--skip-extract)`);
  } else {
    const extractor = extractLlm ? 'llm' : undefined; // undefined → heuristic default
    const label = extractor ? 'LLM (claude -p)' : 'heuristic';
    console.log(`[cognify] workspace=${run.workspace} extractor=${label} fullRescan=true`);
    const t0 = Date.now();
    const result = await runCognify({
      workspace: run.workspace,
      fullRescan: true,
      ...(extractor && { extractor }),
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[cognify done] ${dt}s`);
    console.log(`        framesScanned   : ${result.framesScanned ?? '?'}`);
    console.log(`        entitiesCreated : ${result.entitiesCreated ?? '?'}`);
    console.log(`        entitiesUpdated : ${result.entitiesUpdated ?? '?'}`);
    for (const k of ['relationsCreated', 'extractor']) {
      if (result[k] !== undefined) console.log(`        ${k.padEnd(15)}: ${result[k]}`);
    }
  }

  console.log(`[phase 3] all jobs complete`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

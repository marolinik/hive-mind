#!/usr/bin/env node
// Phase 3-extended — Rechunk + chunk-embed every workspace in RUN-all.json
//
// Iterates over all 10 conv workspaces and runs runMaintenance({rechunkAll})
// against each. Skips entity extraction by default (same rationale as 03 —
// Phase 4 retrieval doesn't read the entity layer; chunks are load-bearing).

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_ALL_FILE = resolve(__dirname, 'data', 'RUN-all.json');

const HIVE_MIND_ROOT = 'D:/Projects/hive-mind';
const MAINTENANCE_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/commands/maintenance.js`).href;

async function main() {
  if (!existsSync(RUN_ALL_FILE)) throw new Error(`RUN-all.json missing — run 02b-ingest-all-convs.mjs first`);
  const runAll = JSON.parse(readFileSync(RUN_ALL_FILE, 'utf8'));
  const { runMaintenance } = await import(MAINTENANCE_URL);

  let totalFrames = 0, totalChunks = 0;
  const tStart = Date.now();
  for (const c of runAll.convs) {
    const t0 = Date.now();
    const r = await runMaintenance({ workspace: c.workspace, rechunkAll: true });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const rk = r.rechunkAll ?? {};
    totalFrames += rk.framesProcessed ?? 0;
    totalChunks += rk.chunksCreated ?? 0;
    console.log(`  c${c.conv_idx} sample=${c.sample_id} ws=${c.workspace}: frames=${rk.framesProcessed ?? '?'} chunks=${rk.chunksCreated ?? '?'} provider=${rk.activeProvider ?? '?'} (${dt}s)`);
  }
  const total = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`[done] ${total}s | total framesProcessed=${totalFrames} chunksCreated=${totalChunks}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });

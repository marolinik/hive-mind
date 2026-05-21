#!/usr/bin/env node
// Phase 10 — Build deterministic N=400 stratified sample for trio-strict run
//
// Replicates the canonical sample-selection algorithm from
// waggle-os/benchmarks/harness/scripts/build-preflight-samples.ts exactly:
//   1. Walk LoCoMo-1540 (locomo10.json), mint instance_id locomo_<sid>_q<idx>
//   2. Bucket by category (1=multi-hop, 2=temporal, 3=open-ended,
//      4=single-hop). Skip 5=adversarial (out of scope for 4-way MECE split).
//   3. Sort each bucket by instance_id ascending (canonical order).
//   4. Fisher-Yates shuffle each bucket with shared xorshift32(seed=42).
//   5. Take first 100 per bucket → N=400 pool.
//
// For cells 2+3 (oracle + substrate retrieval), uses the FIRST 20 per
// bucket from the shuffled pool = N=80 paired-comparable subsample.
// Same 80 questions run through both retrieval conditions, enabling
// per-question delta analysis (where does retrieval miss vs oracle?).
//
// Outputs:
//   data/sample-N400.jsonl       — full 400-question pool
//   data/sample-cells-23.jsonl   — 80-question paired subsample
//   data/sample-MANIFEST.json    — algorithm + seed + counts + sha256

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const DATASET = resolve(DATA_DIR, 'locomo10.json');

// Verified mapping (waggle-os/benchmarks/harness/scripts/build-preflight-samples.ts:26-32)
const CATEGORY_LABEL = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-ended',
  4: 'single-hop',
  5: 'adversarial',  // excluded from 4-way split
};

// xorshift32 — verbatim from build-preflight-samples.ts:102-110
function makeRng(seed) {
  let state = (seed || 1) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

// Fisher-Yates — verbatim from build-preflight-samples.ts:112-119
function fisherYates(items, rand) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function parseDiaId(eid) {
  const m = String(eid).match(/^D(\d+):(\d+)$/);
  return m ? { session: Number(m[1]), turn: Number(m[2]) } : null;
}

function main() {
  if (!existsSync(DATASET)) throw new Error(`Dataset missing — run 00-fetch first`);
  const buf = readFileSync(DATASET);
  const datasetSha = createHash('sha256').update(buf).digest('hex');
  const data = JSON.parse(buf.toString('utf8'));

  const SEED = 42;
  const PER_CATEGORY = 100;       // 4 categories × 100 = N=400 pool
  const PER_CATEGORY_CELLS = 20;  // 4 categories × 20 = N=80 paired sample for cells 2+3

  // 1. Mint canonical instances. Skip cat 5 + skip QAs with empty/unresolvable evidence.
  const buckets = { 1: [], 2: [], 3: [], 4: [] };
  let totalQas = 0, skippedNoEvidence = 0, skippedAdversarial = 0, skippedUnresolvable = 0;

  for (let convIdx = 0; convIdx < data.length; convIdx++) {
    const conv = data[convIdx];
    const qas = conv.qa ?? [];
    for (let qIdx = 0; qIdx < qas.length; qIdx++) {
      totalQas++;
      const qa = qas[qIdx];
      const cat = Number(qa.category);
      if (cat === 5) { skippedAdversarial++; continue; }
      if (!buckets[cat]) continue;
      const evidence = Array.isArray(qa.evidence) ? qa.evidence : [];
      if (evidence.length === 0) { skippedNoEvidence++; continue; }
      // Skip when evidence dia_ids can't be resolved to a real session+turn
      // (defensive — same guard as build-preflight-samples.ts:170)
      const resolvable = evidence.some(eid => {
        const p = parseDiaId(eid);
        if (!p) return false;
        const sk = `session_${p.session}`;
        const session = conv.conversation?.[sk];
        if (!Array.isArray(session)) return false;
        return session.some(t => t.dia_id === eid);
      });
      if (!resolvable) { skippedUnresolvable++; continue; }
      const padded = String(qIdx).padStart(3, '0');
      buckets[cat].push({
        instance_id: `locomo_${conv.sample_id}_q${padded}`,
        sample_id: conv.sample_id,
        conv_idx: convIdx,
        qa_idx: qIdx,
        question: qa.question,
        answer: String(qa.answer),
        evidence,
        category: cat,
        category_label: CATEGORY_LABEL[cat],
      });
    }
  }

  // 2. Sort each bucket by instance_id (canonical order). 3. Shuffle with shared PRNG.
  const rng = makeRng(SEED);
  const order = [1, 2, 3, 4]; // FIXED iteration order (per build-preflight-samples.ts comment in preflight-50 _meta)
  const shuffled = {};
  for (const k of order) {
    buckets[k].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
    shuffled[k] = fisherYates(buckets[k], rng);
  }

  // 4. Take first PER_CATEGORY per bucket → N=400 pool
  const pool = [];
  for (const k of order) {
    const slice = shuffled[k].slice(0, PER_CATEGORY);
    if (slice.length < PER_CATEGORY) {
      console.warn(`[warn] cat ${k} (${CATEGORY_LABEL[k]}) only has ${slice.length} eligible items, requested ${PER_CATEGORY}`);
    }
    for (const it of slice) pool.push(it);
  }

  // 5. Take first PER_CATEGORY_CELLS per bucket from the pool's per-cat slice → cells-2+3 paired sample
  const cells23 = [];
  for (const k of order) {
    const catItems = pool.filter(it => it.category === k).slice(0, PER_CATEGORY_CELLS);
    for (const it of catItems) cells23.push(it);
  }

  // Write outputs
  const poolPath = resolve(DATA_DIR, 'sample-N400.jsonl');
  const cellsPath = resolve(DATA_DIR, 'sample-cells-23.jsonl');
  writeFileSync(poolPath, pool.map(o => JSON.stringify(o)).join('\n') + '\n');
  writeFileSync(cellsPath, cells23.map(o => JSON.stringify(o)).join('\n') + '\n');

  // Manifest
  const manifest = {
    created_at: new Date().toISOString(),
    dataset_sha256: datasetSha,
    seed: SEED,
    algorithm: 'xorshift32(seed=42) + Fisher-Yates per bucket; bucket iteration order [1,2,3,4]; sort by instance_id ascending; verbatim from waggle-os/benchmarks/harness/scripts/build-preflight-samples.ts:101-119',
    category_map: CATEGORY_LABEL,
    excluded_categories: [5],
    bucket_eligible_counts: Object.fromEntries(order.map(k => [k, buckets[k].length])),
    per_category_pool: PER_CATEGORY,
    per_category_cells_2_3: PER_CATEGORY_CELLS,
    total_qas_seen: totalQas,
    skipped_adversarial: skippedAdversarial,
    skipped_no_evidence: skippedNoEvidence,
    skipped_unresolvable: skippedUnresolvable,
    n_pool: pool.length,
    n_cells_2_3: cells23.length,
    pool_sha256: createHash('sha256').update(readFileSync(poolPath)).digest('hex'),
    cells_2_3_sha256: createHash('sha256').update(readFileSync(cellsPath)).digest('hex'),
    note: 'NOT byte-identical to the manifest v6 N=400 fixture (which was not committed to disk). The algorithm and seed are the same, so per-bucket selection order is deterministic and replicable.',
  };
  writeFileSync(resolve(DATA_DIR, 'sample-MANIFEST.json'), JSON.stringify(manifest, null, 2));

  console.log(`[sample] dataset_sha=${datasetSha.slice(0, 16)}...`);
  console.log(`         total qas seen      : ${totalQas}`);
  console.log(`         skipped adversarial : ${skippedAdversarial}`);
  console.log(`         skipped no-evidence : ${skippedNoEvidence}`);
  console.log(`         skipped unresolvable: ${skippedUnresolvable}`);
  console.log(`         eligible per cat    : ${order.map(k => `${CATEGORY_LABEL[k]}=${buckets[k].length}`).join(', ')}`);
  console.log(`[pool]   n=${pool.length} → ${poolPath}`);
  console.log(`[cells]  n=${cells23.length} → ${cellsPath}`);
  console.log(`         per-cat split: ${order.map(k => `${CATEGORY_LABEL[k]}=${cells23.filter(i => i.category === k).length}`).join(', ')}`);
}

main();

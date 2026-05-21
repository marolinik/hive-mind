# LoCoMo Benchmark — hive-mind Memory Substrate

**Headline:** 73.1% (Opus 4.7) / 73.4% (Qwen3.6-35B) on N=320 stratified, **+4.6pp over Mem0 paper** under identical protocol.

> Two very different SOTA models converge to within 0.3pp on identical retrieval substrate. The substrate, not the subject, is the binding constraint.

See [`RESULTS.md`](./RESULTS.md) for the full headline numbers, per-category breakdown, statistical caveats, and cost actuals.

---

## What this benchmark measures

[LoCoMo](https://github.com/snap-research/LoCoMo) is a long-form conversational memory benchmark — 10 conversations × 4 question categories (multi-hop, temporal, open-ended, single-hop). The hive-mind substrate is exercised in two cells:

1. **Oracle cell** — judge sees full conversation as ground truth (sanity ceiling)
2. **Retrieval cell** — judge sees only what hive-mind's HybridSearch retrieves (this is the measurement)

The pass criterion is **memory-lift**: retrieval pass rate measurably above no-context baseline. Stage 3 v6 N=400 result: **Δ +19.25pp, Fisher one-sided p = 8.07 × 10⁻¹⁸**.

## How to run

Prerequisites:

- Node ≥ 20
- A built hive-mind workspace: `npm install && npm run build` from repo root
- `@hive-mind/cli` on PATH (or invoke via workspace)
- API key for your chosen subject + judge models (Anthropic, OpenAI, OpenRouter, etc.)

Scripts are numbered. The minimum to reproduce the v5 retrieval cell + Opus 4.7 self-judge:

```bash
# 1. Fetch LoCoMo data (HuggingFace) + prepare workspace
node 00-fetch-dataset.mjs
node 01-prepare-workspace.mjs

# 2. Ingest + cognify all 10 conversations
node 02b-ingest-all-convs.mjs
node 03b-cognify-all.mjs

# 3. Build N=320 stratified sample
node 10-build-sample.mjs

# 4. Run v5 retrieval cell (Opus 4.7 subject)
node 36-cell-retrieval-v5-claude.mjs

# 5. Judge v5 retrieval (Opus 4.7 self-judge)
node 37-judge-claude-v5.mjs
```

For the **trio-strict ensemble re-judge** (publishable claim path), wire judges 13c/23/33 with the canonical 4-judge roster (Opus 4.7 / GPT-5.4 / Gemini 2.5 Pro / Haiku 4.5).

## Per-step purpose

| Range | Purpose |
|---|---|
| `00-04` | Dataset fetch + workspace prep + ingest + cognify + smoke queries |
| `10-14` | Sample build + oracle cell + retrieval cell + trio-strict judging + report |
| `21-24` | GPT-4o variant cells + apples-to-apples reporting |
| `25-30` | v2/v3 retrieval cells + Mem0-protocol judging |
| `31-37` | v4/v5 with distilled-dense facts, Claude + Qwen subjects, claude judges |

## Methodology docs

- [`docs/LOCOMO-PLAN.md`](./docs/LOCOMO-PLAN.md) — cell design + statistical bar
- [`docs/MEM0-METHODOLOGY.md`](./docs/MEM0-METHODOLOGY.md) — Mem0 verbatim protocol replication
- [`docs/COMPARE-vs-prior.md`](./docs/COMPARE-vs-prior.md) — version-over-version progression

## Caveats

- Self-judge inflation: v5 RESULTS.md uses Opus self-judge. Trio-strict ensemble re-judge converts the number from "internal" to "publishable" (~$30 / ~2h).
- No data files committed here — scripts fetch LoCoMo from upstream on first run.

## Cost actuals (v5)

- Retrieval (320 Opus calls, ~4K input + 10 output tokens avg): ~$5
- Judge (320 Opus calls, ~500 input + 100 output): ~$4
- **Total v5 = ~$9**

License: Apache-2.0 (same as parent repo).

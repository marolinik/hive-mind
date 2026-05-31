# LoCoMo v5 — committed reproducibility artifacts

These files let anyone re-derive the published LoCoMo benchmark headline **offline,
with zero API calls**. They are the regression baseline for the substrate's benchmark
claim — if the substrate or scoring changes, the rescore is expected to change with it.

## Reproduce

```bash
node benchmarks/locomo/rescore.mjs
```

Expected output (exit 0):

```
  Trio-strict (AND of 3)   217/320 = 67.8%
  Trio-majority (>=2 of 3) 224/320 = 70.0%
  Parse failures           4/320
  single-hop   70/80   multi-hop 49/80   temporal 52/80   open-ended 46/80
  opus 230/320   gpt 223/320   mm 236/320
```

The rescore is intentionally adversarial about its own inputs:

1. **Tamper-evidence** — verifies each artifact's `sha256` against `MANIFEST.json`.
2. **Independent recompute** — re-derives every per-row verdict from the raw per-judge
   verdicts using the canonical rule, then cross-checks it against the committed
   `trio_strict` / `trio_majority` fields (0 mismatches expected).
3. **Aggregate assertions** — the strict / majority / per-category / per-judge tallies
   must match `MANIFEST.json → expected` exactly, or it exits 1.

## What "trio-strict" means

Three independent-family judges scored the same 320 v5 answers with the Mem0 verbatim
"be generous" accuracy prompt:

| Judge | Model |
|---|---|
| opus | `claude-opus-4-7` |
| gpt  | `gpt-5.5-2026-04-23` |
| mm   | `MiniMax-M2.7` |

**Trio-strict** = logical AND of the three (CORRECT only when all three say CORRECT) —
conservative by design. A row where any judge failed to parse is excluded (counts as
not-correct; the denominator stays 320). 4 rows are irrecoverable parse noise (1.25%).

Self-judge (Opus alone) on the same answers is **234/320 = 73.1%** — i.e. self-judge
inflation of **+5.3pp** over the trio-strict 67.8%. Both numbers are defensible; cite
whichever matches the venue's methodology bar. See [`../RESULTS.md`](../RESULTS.md).

## Files

| File | Role |
|---|---|
| `trio-judgments-v5-retrieval.v2.jsonl` | **The rescore input** — canonical per-row trio judgments (320 rows, post parser-fix v2). |
| `cell-retrieval-v5-claude.jsonl` | Provenance — the v5 retrieval answers that were judged. |
| `sample-cells-23-N320.jsonl` | Provenance — the N=320 stratified question sample (the test set). |
| `dataset-MANIFEST.json` | Upstream LoCoMo dataset provenance (source URL + sha256 + shape). |
| `sample-MANIFEST.json` | Sampling provenance — `seed=42`, xorshift32 + Fisher-Yates, per-bucket SHAs. |
| `MANIFEST.json` | Pins all artifact sha256s + dataset SHA + seed + the expected-results contract. |

## Provenance & pinning

- **Dataset:** `snap-research/locomo` → `data/locomo10.json`,
  sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.
- **Sample:** N=320, stratified 80× per category over [multi-hop, temporal, open-ended,
  single-hop]; adversarial (category 5) excluded. Deterministic: `seed=42`.
- **Subject:** v5 frozen architecture — distilled-dense facts + K=5 importance + K=10
  semantic + reranker + synthesis-encouraging system prompt; subject model Opus 4.7.

Regenerating the answers/judgments from scratch (the numbered `benchmarks/locomo/*.mjs`
harness) requires API keys and ~$9–13 of spend. This rescore needs neither — it only
re-aggregates the committed judgments.

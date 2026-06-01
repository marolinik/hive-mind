# Benchmark Methodology

This document pins **how** hive-mind's published benchmark numbers are produced, so a
third party can audit or reproduce them. Every value here is sourced from the committed
artifacts (`benchmarks/locomo/artifacts/MANIFEST.json`) and the run record
(`benchmarks/locomo/RESULTS.md`) — not from memory. When the two disagree, the MANIFEST
is canonical (it is what `rescore.mjs` re-derives offline).

## Reproduce the headline offline (zero API calls)

```bash
node benchmarks/locomo/rescore.mjs
```

This re-derives the LoCoMo trio-strict headline (**217 / 320 = 67.8 %**) from the committed
per-row judgments with no network and no model calls. It also re-checks the SHA-256 of each
committed artifact against the MANIFEST, so a tampered or truncated artifact fails loudly.

## LoCoMo

| Field | Value |
|---|---|
| Benchmark | LoCoMo (Long Conversation Memory) |
| Dataset | `snap-research/locomo` `locomo10.json` |
| Dataset SHA-256 | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` (2 805 274 bytes) |
| Dataset source | https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json |
| Sample size | N = 320 |
| Stratification | 80 per category across [multi-hop, temporal, open-ended, single-hop]; adversarial (category 5) excluded |
| Sampling seed | 42 |
| Sampling algorithm | `xorshift32(seed=42)` + Fisher-Yates per bucket; bucket order [1,2,3,4]; sort by `instance_id` asc |
| Subject model (headline) | `claude-opus-4-7` (Anthropic Messages API) |
| Retrieval substrate | v5 frozen — distilled-dense facts (~53/conv) + K=5 importance + K=10 semantic + cross-encoder reranker + synthesis-encouraging system prompt |

### Judges

Three independent-family judges, each polled with the Mem0 verbatim "be generous" accuracy prompt:

| Role | Model |
|---|---|
| Anthropic | `claude-opus-4-7` |
| OpenAI | `gpt-5.5-2026-04-23` |
| MiniMax | `MiniMax-M2.7` |

- **Trio-strict** (canonical, conservative): CORRECT only when **all three** judges return CORRECT (logical AND). A row where any judge fails to parse is excluded — counted as not-correct, denominator stays 320.
- **Trio-majority**: CORRECT when **≥2 of 3** judges return CORRECT; parse-failure rows likewise counted as not-correct.
- **Self-judge** (reference only): Opus 4.7 judging Opus 4.7 answers — disclosed as inflated, never the headline.

### Headline numbers (re-derivable by `rescore.mjs`)

| Metric | Value |
|---|---|
| Trio-strict (AND of 3) | **217 / 320 = 67.8 %** |
| Trio-majority (≥2 of 3) | 224 / 320 = 70.0 % |
| Self-judge (Opus alone, reference) | 234 / 320 = 73.1 % |
| Self-judge inflation | +5.3 pp |
| Parse failures | 4 / 320 = 1.25 % (irrecoverable noise) |

Per-category trio-strict: single-hop 70/80, multi-hop 49/80, temporal 52/80, open-ended 46/80.
Per-judge totals: opus 230, gpt 223, mm 236.

**Which number to cite:** trio-strict (67.8 %) for a conservative, cross-family bar; self-judge
(73.1 %) only when the venue's methodology explicitly permits self-judging, and always labelled as such.

### Cost actuals

| Item | Cost |
|---|---|
| v5 retrieval (320 Opus 4.7 subject calls) | ~$5 |
| Trio judging (full 320 + redo of 63 parse-failures) | ~$14–17 |
| **Total LoCoMo evaluation** | **~$23–26** |

The offline `rescore.mjs` path costs **$0** — that is the intended verification route for anyone
checking the published number.

## recall-stress (in-repo regression gate, no API cost)

A fast precision@3 gate over a parameterized query set, run against the built CLI's
`recall-context --json`.

```bash
node benchmarks/recall-stress/run.mjs [--queries <path>] [--profile <p>] [--min-precision 0..1] [--max-seconds <n>] [--out <path>]
```

- **Queries are parameterized.** `queries.example.json` ships as a neutral template;
  operators supply their own `queries.local.json` (gitignored). The original `.harvest`
  script hardcoded one operator's proprietary corpus — that must never reach this repo.
- **Scoring:** top-3 substring match against each query's `expect[]`; edge queries
  (`expect: []`) score 1 only when the top result's score is below 0.02 (nothing relevant).
- **Reporting:** global average precision@3 **plus** a per-category rollup (grouped by `cat`),
  so a regression localized to one query class is visible rather than averaged away.
- **Gate:** non-zero exit if the run exceeds `--max-seconds` (default 60), if average
  precision falls below `--min-precision`, or if any query errors.
- **`HIVE_MIND_NO_RERANK=1`** defaults on inside the harness: each query is a fresh process,
  so loading the ~87 MB reranker per query would blow the time gate. Operators can override.

## LongMemEval

Not yet run in-repo. The sandbox harness (external) and the net-new official-harness
`HiveMindRetriever` integration are tracked in `PRODUCTION-CONSOLIDATION-PLAN.md` (Phase 4) and
`.planning/P2-READINESS.md`. Until a verified in-repo run exists, the README badge stays
"harness ready / run pending" — no number is published before `rescore`-style reproduction is possible.

## Principles

- **Offline-reproducible headline.** The published LoCoMo number must be re-derivable from
  committed artifacts with zero API calls (`rescore.mjs`); the SHA-pinned dataset + seed make
  the sample itself reconstructible.
- **Label every cell with its subject and judge.** Never compare numbers across different
  retrieval substrates without re-baselining — substrate changes (e.g. wiring the reranker into
  a new path) invalidate prior numbers for that path.
- **Conservative judge by default.** Headline on trio-strict; disclose self-judge inflation.
- **No fabricated badges.** A benchmark badge shows a number only after that number is reproduced
  in-repo.

# LoCoMo Memory-SOTA — 86.49% (7-lane W4, N=1540, same-judge vs Memori)

**Reproduced & pinned 2026-07-01.** Subject = gpt-4.1-mini, judge = gpt-4.1-mini + Memori's
verbatim "be generous" ACCURACY_PROMPT, natural full-N distribution, overall = count-weighted
micro-average. Full 7-lane W4 stack (distilled + semantic + importance-K5 + episodic + profiles +
date-window + raw-detail/CE-rerank), uncapped.

> **Correction note.** The original 2026-06-11 report claimed **87.66%**. That number did **not
> reproduce** on a fresh judge pass — on its own archived 2026-06-11 substrate it re-scores 85.19%,
> and on the current substrate 86.49% — consistent with the stale-verdict-replay bug documented in
> the harness on 2026-06-15 (`judge resumes by question_id and replayed stale verdicts`). The
> original 1350-correct judgment set is lost and unreproducible. **86.49% is the honest, fresh,
> reproducible figure** (verify with `node recount.mjs`). See
> `docs/analysis/locomo-87.66-vs-85.26-integrity-2026-06-30.md`.

## Head-to-head vs Memori Table 1 (N=1540)

| Category | Memori (Table 1) | **Our substrate** (gpt-4.1-mini) | Δ vs Memori | n |
|---|--:|--:|--:|--:|
| single-hop | 87.87 | **92.27%** (776/841) | +4.40pp | 841 |
| multi-hop | 72.70 | **80.50%** (227/282) | +7.80pp | 282 |
| temporal | 80.37 | **81.62%** (262/321) | +1.25pp | 321 |
| open-ended | 63.54 | **69.79%** (67/96) | +6.25pp | 96 |
| **Overall** (count-weighted) | **81.95** | **86.49%** (1332/1540) | **+4.54pp** | 1540 |

One-sample proportion test vs Memori's fixed 81.95%: **z = 4.64, p < 10⁻⁵** (one-sided).
Memori baseline reproduced first on our own harness: nb02 = 81.98 vs published 81.95 (ruler validated).

## Competitor re-run — Mem0 (same answerer + judge, our ruler)

| Category | **Ours (7-lane W4)** | **Mem0 (our ruler)** | Δ |
|---|--:|--:|--:|
| single-hop | 92.27 | 83.59 | +8.68 |
| multi-hop | 80.50 | 74.82 | +5.68 |
| temporal | 81.62 | **50.78** | **+30.84** |
| open-ended | 69.79 | 64.58 | +5.21 |
| **overall** | **86.49** | **73.96** | **+12.53** |

Lead every category on Mem0's own protocol; temporal by +30.84pp — write-time-dated episodic
timeline vs Mem0's ingestion-time stamping. (Mem0 judgments: 1139/1540 = 73.96%, committed.)

## Tokens/query
avg context_tokens ≈ **3,100** on this run (per-row `context_tokens` in the answers file; the
`42-report` tokens/query line is a known display bug — ignore it). The token-Pareto knee (Config D,
−28% tokens for ~−1pp) was measured on a prior answer set and should be **re-measured on this
substrate** before re-citing exact numbers.

## Reproduce
- **Offline (zero API):** `node recount.mjs` — recounts `data/judgments/…-N1540.jsonl` → 1332/1540.
- **Full regen:** in `hive-mind-test/scripts/locomo`,
  `PROMPT_MODE=ours PROFILES=1 DATEWIN=1 EPISODIC=1 RAWDETAIL=1 OUT_TAG=<fresh> node 40-cell-retrieval-gpt41mini.mjs`
  then `41-judge --in=…-<fresh>.jsonl`. **Always use a fresh `OUT_TAG`** — reusing an existing
  judgments file triggers the stale-verdict replay that produced the bogus 87.66.

## Provenance (pinned together — this is the fix for the drift)
- Answers: `data/answers/locomo-7lane-w4-answers-N1540.jsonl` (7-lane: raw_detail≈16, importance≈4.5).
- Judgments: `data/judgments/locomo-7lane-w4-judgments-N1540.jsonl` (recount = 1332/1540).
- Substrate: 10 LoCoMo workspace minds (`~/.hive-mind/workspaces/proj-locomo-*`), current (2026-06-29) build.
- Zep + LangMem stay literature-sourced (founder decision 2026-06-16).

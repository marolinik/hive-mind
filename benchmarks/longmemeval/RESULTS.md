# LongMemEval Results — hive-mind Memory Substrate

> **STATUS: PRELIMINARY / IN PROGRESS.** The harness is validated end-to-end; the
> first stratified pilot (N=100, GPT-4o) is running. This file is updated with the
> measured number on completion. Nothing here is a SOTA claim yet — see the honest
> framing below.

## Configuration

- **Benchmark:** LongMemEval V1 S-variant, N=500 (Wu et al. 2024). dataset_version `a8a99545...` (matches the published canonical build).
- **Substrate:** base `HybridSearch` — RRF (k=60) + 4-profile scoring; per-question ephemeral in-memory mind; frame-per-turn ingest; local Ollama `nomic-embed-text` (1024-d). **Not** the full 7-lane W4 assembler (see caveat).
- **Answerer / Judge:** GPT-4o / GPT-4o ("be generous"); abstention scored deterministically.
- **Retrieval K:** 10. Cross-encoder rerank: off (Phase 1a).

## Measured (this harness)

Two substrate configurations, same instances:
- **base** = `HybridSearch` (RRF k=60 + 4-profile scoring) — `20-run.mjs`
- **lanes** = base + cross-encoder rerank + raw-detail escalation lane + date-window lane + W1 answer policy (Phase 1b-i) — `22-run-lanes.mjs`

| Config | N | Answerer | Overall | Notes |
|---|---:|---|---:|---|
| base | 5 | GPT-4o | 60.0% | smoke; multi-session 0/2 |
| lanes | 5 | GPT-4o | 80.0% | same 5; raw-detail firing |
| **lanes (1b-i)** | **500** | GPT-4o | **66.20%** | full set, 500/500, 0 errors — **reportable** |

**Phase 1b-i, N=500, per-question-type (GPT-4o answerer + judge):**

| Category | n | acc% |
|---|---:|---:|
| single-session-user | 70 | 98.6 |
| single-session-assistant | 56 | 94.6 |
| knowledge-update | 78 | 88.5 |
| multi-session | 133 | 50.4 |
| temporal-reasoning | 133 | 48.9 |
| single-session-preference | 30 | 26.7 |
| **OVERALL** | **500** | **66.20** |

**Placement (honest):** 66.2% is below the leaderboard (Mastra 94.9 / mem0 93.4 /
Supermemory 85.4, all GPT-4o-family) — as expected for Phase 1b-i, which has NO
write-time distillation. The ladder localizes the gap precisely: single-session
categories are ~95-99% (retrieval works), while the three synthesis/temporal
categories lag — temporal 48.9 (needs write-time date resolution, the LoCoMo P4
rung), preference 26.7 + multi-session 50.4 (need profile cards, the W2a rung).
Those are exactly the Phase 1b-ii lanes (`24-run-lanes-plus.mjs`, queued).

## Where this sits vs the field (external, June 2026)

| System | LongMemEval overall | Answerer | Source |
|---|---:|---|---|
| Mastra Observational Memory | 94.87% | GPT-5-mini | mastra.ai/research |
| Mem0 | 93.4% | GPT-4o(-mini) | mem0.ai/research |
| Hindsight | 91.4% | Gemini-3 Pro | arXiv:2512.12818 |
| Supermemory | 85.4% | GPT-4o | supermemory.ai |
| Letta | ~83.2% | (3rd-party) | community |
| **hive-mind (base substrate)** | _pending_ | GPT-4o | this harness |

These are protocol-relative: answerer choice moves the number materially
(Observational Memory: 84.2% on GPT-4o vs 93.3% on Gemini-3-pro). We hold GPT-4o
fixed for comparability with the paper/Mem0/Supermemory rows.

## Honest framing (read before quoting any number)

1. **Base substrate, not the winning stack.** This run uses base `HybridSearch`.
   It does not yet include the 7-lane W4 assembler that produced the 87.66% LoCoMo
   SOTA. The synthesis-heavy categories (multi-session, temporal) are exactly the
   ones the missing lanes target, so the Phase 1a number is a **baseline**.
2. **The gap-closing path is specified** (PREREGISTRATION.md, Phase 1b): port the
   lanes, each under a z-gate. The LongMemEval abilities map directly onto them.
3. **No SOTA claim from Phase 1a.** A LongMemEval SOTA-or-parity claim is a Phase
   1b deliverable, stated per-answerer, per-protocol, with an independent re-judge.

## Reproduce

See [`README.md`](./README.md). Offline rescore of any committed judgments file:
`node 40-report.mjs --judged <file>`.

License: Apache-2.0.

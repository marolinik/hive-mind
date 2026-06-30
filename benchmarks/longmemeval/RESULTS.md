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

| Run | N | Answerer | Overall | Notes |
|---|---:|---|---:|---|
| Smoke | 5 | GPT-4o | 60.0% | end-to-end validation (knowledge-update 2/2, single-session-user 1/1, multi-session 0/2) |
| Pilot | 100 | GPT-4o | _pending_ | stratified; running |
| Full | 500 | GPT-4o | _pending_ | next |

Per-question-type breakdown is filled by `40-report.mjs` on completion.

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

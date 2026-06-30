# LongMemEval — Preregistration (hive-mind)

**Track:** A0 of the memory-SOTA campaign (LongMemEval -> BEAM-CR -> LoCoMo multi-model sweep -> agentic).
**Benchmark:** LongMemEval V1, S-variant (Wu et al. 2024, arXiv:2410.10813). N=500, dataset_version `a8a99545d77a236e3c7aa1f5d0ccfd94d4bcc5c2d5adbd19f938aba844586c56` (matches the published canonical build).

## Central claim (unchanged from the LoCoMo work)

The hive-mind substrate, not the subject model, is the binding constraint on
long-term conversational memory. We test it on a second benchmark (LongMemEval)
under a comparable, reproduced protocol, across multiple answerer models.

## Protocol (pinned before running)

- **Answerer (primary):** GPT-4o — the model the Wu et al. paper, Mem0, and
  Supermemory report on, so our number is directly comparable.
- **Answerer (sweep):** gpt-5-mini (to contest Mastra's 94.87 on its own model),
  gpt-4.1-mini (cross-benchmark consistency with our LoCoMo protocol), and a
  Gemini variant (to sit beside Hindsight's Gemini-3 number). The convergence of
  the substrate across these answerers is the load-bearing result.
- **Judge:** GPT-4o, "be generous" LLM-as-judge, held fixed across every cell.
  Abstention questions scored deterministically (correct iff the answer abstains).
- **Embedder:** local Ollama `nomic-embed-text` (1024-d) — fully local.
- **Statistics:** every substrate change is gated by a full-N two-proportion
  z-test against the previous configuration. Per-question answers and judgments
  archived. Headline claims also re-judged by an independent model to report
  self-judge inflation, as in the LoCoMo work.

## Phases

- **Phase 1a — base substrate (this harness).** Base `HybridSearch` (RRF k=60 +
  4-profile scoring + optional ONNX cross-encoder rerank), per-question ephemeral
  mind, frame-per-turn ingest. Produces the baseline LongMemEval number under the
  GPT-4o protocol. Pilot N=100, then full N=500.
- **Phase 1b — lane-stack port (gap-closing).** Port the 7-lane W4 context
  assembler that produced the 87.66% LoCoMo SOTA: profile cards, write-time-dated
  episodic timeline, date-window lane, importance lane, semantic snippets,
  raw-detail escalation. Each lane added under a pre-registered z-gate. The
  LongMemEval abilities map directly onto these lanes (knowledge-update -> B-frame
  corrections + bitemporal KG; temporal -> write-time dating + date-window lane;
  abstention -> retrieval-confidence abstain path).

## Success criteria (defensible, staged)

1. **Parity floor:** clear Supermemory's 85.4% (GPT-4o) under the same answerer.
2. **Competitive:** reach the 90%+ band that mem0 (93.4) and Mastra (94.87, on
   gpt-5-mini) report, on the matched answerer, via the Phase 1b lane stack.
3. **The real prize:** demonstrate substrate-over-subject convergence across >=2
   answerer families on identical retrieval, as we showed on LoCoMo (0.3pp Opus
   vs Qwen).

A number is publishable only when it meets the LoCoMo bar: baseline reproduced
where a competitor's pipeline is reproducible, z-gated interventions, named
answerer, independent re-judge with inflation reported, archived artifacts, and
explicit limitations (answerer dependence, single benchmark, judge dependence).

## Honest expectations

The Phase 1a base-substrate number is a **baseline and will not be SOTA** — the
synthesis-heavy categories (multi-session, temporal) need the Phase 1b lanes.
Vendor leaderboard numbers also use stronger answerers; we hold GPT-4o fixed for
comparability and report the multi-model sweep separately. "SOTA on LongMemEval"
is a Phase 1b target, claimed only per-answerer, per-protocol.

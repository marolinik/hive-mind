# LongMemEval Benchmark — hive-mind Memory Substrate

A runnable LongMemEval V1 (S-variant) harness for the hive-mind substrate, in the
style of `benchmarks/locomo/`. It measures the memory substrate under a
**comparable, published protocol** (GPT-4o answerer + judge), so the number sits
on the same axis as Mem0, Supermemory, Mastra, and the LongMemEval paper.

> **Status:** harness validated end-to-end (5-instance smoke green). First
> stratified pilot (N=100, GPT-4o) is the initial number; the full N=500 run is
> a re-run away. See [`RESULTS.md`](./RESULTS.md) and
> [`PREREGISTRATION.md`](./PREREGISTRATION.md).

## What this measures

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al. 2024,
arXiv:2410.10813, ICLR 2025) evaluates five long-term-memory abilities over
multi-session chat histories: information extraction, multi-session reasoning,
temporal reasoning, knowledge update, and abstention. The S-variant is 500
questions, each with a ~115K-token haystack.

The substrate cell works like the LoCoMo retrieval cell: for each question we
build a fresh in-memory mind, ingest that question's haystack as one frame per
turn, retrieve the top-K frames via hive-mind `HybridSearch`, and have a
comparable answerer model answer from the retrieved snippets only. The answerer
never sees the full haystack, so its cost is small and the measurement isolates
retrieval quality.

## Protocol (for comparability)

| Element | Choice | Why |
|---|---|---|
| Answerer | **GPT-4o** (default; sweepable to gpt-5-mini, gpt-4.1-mini, gemini) | The Wu et al. paper, Mem0, and Supermemory all report on GPT-4o; Mastra's 94.87 used GPT-5-mini |
| Judge | **GPT-4o**, "be generous" prompt | Standard LLM-as-judge; same family held fixed |
| Abstention | deterministic (correct iff the answer abstains) | LongMemEval's abstention ability |
| Embedder | local Ollama `nomic-embed-text` (1024-d via hive-mind's ollama-embedder) | fully local; no embedding leaves the machine |
| Retrieval | base `HybridSearch` — RRF (k=60) + 4-profile scoring + optional ONNX cross-encoder rerank | see the honest caveat below |

## Honest caveat: base substrate, not the full lane stack

This harness exercises the **base `HybridSearch`** retrieval path. It does **not**
yet run the full 7-lane W4 context assembler (profile cards, write-time-dated
episodic timeline, date-window lane, importance lane, semantic snippets,
raw-detail escalation) that produced the 87.66% LoCoMo SOTA. The base-substrate
number is therefore a **baseline**, expected to trail the lane-stack systems on
the synthesis-heavy categories (multi-session, temporal). Porting the lane stack
to this cell is the gap-closing path (see `PREREGISTRATION.md`, Phase 1b).

## How to run

Prerequisites: Node >= 20, a built hive-mind (`npm install && npm run build` at
repo root), Ollama serving `nomic-embed-text` on `localhost:11434`, and
`OPENAI_API_KEY` in an env file (default `D:/Projects/waggle-os/.env`; override
with `WAGGLE_ENV_PATH`).

```bash
# 1. Fetch the dataset (~264 MB) into data/
curl -L -o data/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

# 2. Build the canonical archive (provenance hash; matches the published build)
node --max-old-space-size=8192 00-build-canonical.mjs

# 3. Build a stratified sample with structured turns
node --max-old-space-size=8192 10-build-sample.mjs --n 100   # or --n 500 for the full set

# 4. Run the substrate retrieval cell (resumable; ingest ~40 s/instance, local embedding)
node 20-run.mjs --sample data/sample-100.jsonl --model gpt-4o --k 10   # add --rerank for the cross-encoder

# 5. Judge (LLM-as-judge) + report
node 30-judge.mjs --answers data/answers/answers-sample-100-gpt-4o.jsonl --judge gpt-4o
node 40-report.mjs --judged data/judgments/judged-answers-sample-100-gpt-4o-by-gpt-4o.jsonl
```

## Scripts

| Script | Purpose |
|---|---|
| `00-build-canonical.mjs` | Raw HF JSON -> canonical JSONL + meta (SHA-256 dataset_version; matches the published build `a8a99545...`) |
| `10-build-sample.mjs` | Deterministic stratified sample with per-turn structure |
| `20-run.mjs` | Base cell: ephemeral-mind ingest + HybridSearch retrieval + comparable-model answer |
| `22-run-lanes.mjs` | Lanes cell (Phase 1b-i): raw-turn ingest with session dates + cross-encoder rerank + raw-detail escalation lane + date-window lane + W1 answer policy |
| `30-judge.mjs` | LLM-as-judge (CORRECT/WRONG) + deterministic abstention scoring |
| `40-report.mjs` | Overall + per-question-type accuracy |

## Cost and time

The answerer/judge cost is small (retrieved snippets only): a full 500-question
run is roughly $5-6 in GPT-4o usage. The wall-clock cost is local embedding at
ingest (~40 s/instance), so the full 500 set is a multi-hour background run.

License: Apache-2.0 (same as the parent repo).

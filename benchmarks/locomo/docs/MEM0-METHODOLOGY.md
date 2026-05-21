# Mem0 LoCoMo Methodology — Verified 2026-05-08

**Sources (primary, fetched live):**
- arxiv:2504.19413 — "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory" (Chhikara et al.)
- `github.com/mem0ai/mem0/evaluation/metrics/llm_judge.py` — actual evaluation code, fetched verbatim
- `mem0.ai/research` — newer "token-efficient" algorithm blog (source of the 91.6% headline)

---

## The 91.6% number — what it actually is

**91.6% does NOT come from the published paper.** The peer-reviewed paper (arxiv:2504.19413) reports overall J of **66.88% (Mem0 base)** and **68.44% (Mem0^g graph)** — confirmed live from the paper HTML.

The 91.6% headline appears on `mem0.ai/research` in the context of "Mem0's new token-efficient memory algorithm" — a newer, blog-published variant whose methodology isn't fully documented in the paper. Per the live page itself, "the relationship between this 85.0 overall score and the 91.6 headline metric is unexplained on this page."

**Implication: 91.6% is a marketing/blog claim, not the peer-reviewed number.** The defensible apples-to-apples baseline is **66.88% / 68.44%** from the published paper Table 1/2.

---

## Mem0's exact judge — verbatim from `evaluation/metrics/llm_judge.py`

**Model:** `gpt-4o-mini`
**Temperature:** `0.0`
**Response format:** `{"type": "json_object"}` (forces JSON output)
**Score:** Binary 0/1 (`CORRECT` → 1, `WRONG` → 0)
**Aggregation:** Per-category mean → per-category J score; overall J is the average across categories.

**Verbatim prompt (single user message, no system prompt):**

```
Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a 'gold' (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {generated_answer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
```

**Two key features of this prompt that move scores UP vs our trio-strict prompt:**
1. **"be generous with your grading"** — explicit instruction to grade leniently. Our trio-strict prompt instead says "incorrect if hallucinates / refuses / gets specifics wrong."
2. **Lenient time-format matching** — "May 7th" and "7 May" both count CORRECT. We didn't explicitly allow this.

---

## Mem0 paper Table 1/2 — per-category J scores (fetched live)

### Mem0 (base)
| Category | F1 | B1 (BLEU-1) | **J (LLM-judge)** |
|---|---|---|---|
| Single-Hop | 38.72 | 27.13 | **67.13 ± 0.65** |
| Multi-Hop | 28.64 | 21.58 | **51.15 ± 0.31** |
| Open-Domain | 47.65 | 38.72 | **72.93 ± 0.11** |
| Temporal | 48.93 | 40.51 | **55.51 ± 0.34** |
| **Overall J** | | | **66.88 ± 0.15** |

### Mem0^g (graph-enhanced)
| Category | F1 | B1 | **J** |
|---|---|---|---|
| Single-Hop | 38.09 | 26.03 | **65.71 ± 0.45** |
| Multi-Hop | 24.32 | 18.82 | **47.19 ± 0.67** |
| Open-Domain | 49.27 | 40.30 | **75.71 ± 0.21** |
| Temporal | 51.55 | 40.28 | **58.13 ± 0.44** |
| **Overall J** | | | **68.44 ± 0.17** |

These are the **substrate-retrieval-cell** numbers — Mem0 stores, retrieves, generates, GPT-4o-mini judges.

### Comparable competitor — Memobase v0.0.37 (per their own README)
- Single-hop: 70.92
- Multi-hop: 46.88
- Open-domain: 77.17
- Temporal: 85.05

(Suggests Memobase **beats Mem0 paper** on 3 of 4 categories using same judge protocol.)

---

## Where our current run diverges from Mem0's protocol

| Aspect | Mem0 | Our trio-strict run | Our self-judge run | Apples-to-apples? |
|---|---|---|---|---|
| **Judge model** | gpt-4o-mini | Opus 4.7 + GPT-5.5 + MiniMax-M2.7 | qwen3.6-35b-a3b | ❌ — different judges |
| **Judge prompt** | "be generous" + lenient on time | Strict ("hallucinates / refuses / wrong specifics") | Same strict | ❌ — stricter rubric |
| **Aggregation** | Single judge → 0/1 | All-3-agree → 0/1 (strict AND) | Single judge → 0/1 | ❌ — strict AND vs single |
| **Categories** | 4-way (cat 5 excluded) | 4-way (cat 5 excluded) | 4-way (cat 5 excluded) | ✅ |
| **Subject model** | (varies by paper config) | qwen3.6-35b-a3b thinking=ON | (same) | partial — Qwen subject |
| **Cell** | Substrate retrieval | Retrieval + Oracle (both) | Both | ✅ for retrieval cell |
| **N** | LoCoMo-1540 (full) | 80 paired (4×20 stratified) | 80 paired | ❌ — N=80 vs full ~1500 |

**Three of those rows produce DOWNWARD bias in our score relative to Mem0's:** stricter judge prompt, strict-AND aggregation, possibly stricter judges. The N=80 stratified subset isn't a directional bias but is a precision concern (CIs are wider).

---

## What we need to add for a defensible "vs Mem0" claim

A **fourth judge cell** running Mem0's exact methodology on our existing answers:

1. Use **gpt-4o-mini** as judge (we have an OpenAI key)
2. Use **Mem0's exact prompt** (quoted above, verbatim)
3. **Binary 0/1 score**, JSON output, temperature 0
4. Run against `cell-retrieval.jsonl` (the substrate-retrieval cell — directly comparable to Mem0's Table 1)
5. Per-category J + Overall J as the headline number
6. Cost: 80 × ~$0.0001 = **~$0.01** (gpt-4o-mini is dirt cheap)
7. Time: ~5 min

This produces the **"Waggle post-Phase-3 substrate retrieval J under Mem0-protocol"** number — the only number we can put alongside Mem0's published 66.88% / 68.44% without methodology asterisks.

We should ALSO run it on `cell-oracle.jsonl` (our oracle cell) to position the substrate-quality ceiling against the prior 74% trio-strict oracle, but using Mem0's lenient single-judge protocol. This produces a "Waggle oracle under Mem0 protocol" number that anchors the methodology gap our way.

**Proposed harness:** `13c-judge-mem0.mjs` — variant of the self-judge harness with Mem0's prompt + GPT-4o-mini.

---

## Recommendation for the writeup

Report **four numbers per cell**:
1. **Trio-strict (rigorous)** — Opus + GPT-5.5 + MiniMax, all-3-agree. The conservative ceiling.
2. **Self-judge (Qwen judges Qwen)** — methodology-gap demonstration on our system.
3. **Mem0-protocol (gpt-4o-mini, lenient)** — directly comparable to Mem0 paper Table 1.
4. **evidence_recall@5** — deterministic floor, free, already computed in Phase 4.

The headline "vs Mem0" claim uses #3. The headline "rigorous accuracy" claim uses #1. The methodology gap is #3 − #1 (or #3 − #2).

Sources:
- [Mem0 paper (arxiv)](https://arxiv.org/abs/2504.19413)
- [Mem0 evaluation code (judge prompt verbatim)](https://github.com/mem0ai/mem0/blob/main/evaluation/metrics/llm_judge.py)
- [Mem0 research blog (91.6% headline source)](https://mem0.ai/research)
- [Mem0 vs OpenAI/LangMem/MemGPT blog (per-category numbers)](https://mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0-for-long-term-memory-here-s-how-they-stacked-up)
- [Memobase LoCoMo README (competitor comparison)](https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md)
- [LoCoMo benchmark (Maharana et al., snap-research)](https://snap-research.github.io/locomo/)

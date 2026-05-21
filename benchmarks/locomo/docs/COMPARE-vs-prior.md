# LoCoMo Replay 2026-05-08 — Comparison vs Prior PM-Waggle-OS Benchmarks

**Today's run:** conv-26 only (sample_id from `data/locomo10.json[0]`), 199 questions, post-Phase-3 substrate (reranker + semantic chunker + 8k-capable embedder + per-workspace cognify), library-mode CLI driver, no LLM judge yet.

**Sources for prior numbers:**
- `D:\Projects\PM-Waggle-OS\strategy\methodology\2026-05-02-methodology-doc-FINAL.md`
- `D:\Projects\PM-Waggle-OS\research\2026-04-26-arxiv-paper\03-paper-skeleton-v2-2026-04-30.md`
- `D:\Projects\PM-Waggle-OS\tmp_git_audit.txt.out` — commits b7e19c5 + afe6422 (Stage 3 v6 N=400, 2026-04-25)

---

## Headline numbers — both sides

### Prior (Stage 3 v6, N=400 stratified, trio-strict, end-to-end LLM-judge)

| Cell | Score | Notes |
|---|---|---|
| Full-context oracle (Waggle) | **74%** | LLM gets entire conversation history → answers questions → trio-strict judges |
| Mem0 same-protocol equivalent | **66.9%** | Mem0's stack re-judged under trio-strict (their published 91.6% was self-judge) |
| **V1 substrate retrieval** | **22.25%** | Pre-Phase-3 substrate; LLM gets retrieval-mediated context |
| Oracle gap above no-context | +27.25pp | Headroom for retrieval improvement |
| V1 retrieval gap below oracle | **−51.75pp** | V1 retrieval was leaving ~52pp on the table |
| Self-judge bias across systems | +27.35pp | Single-judge inflates vs trio-strict |

Methodology: trio-strict judges (Opus 4.6 + GPT-5 + MiniMax M2.7, κ_trio = 0.7878, ALL must agree). Subject model: Qwen3.6-35B-A3B, thinking=off, max_tokens=16000. Pre-registered manifest v6, anchor commit `b7e19c5`.

### Today (conv-26, N=199, post-Phase-3 substrate, retrieval-only)

**Category mapping (verified 2026-05-08 against `waggle-os/benchmarks/harness/scripts/build-preflight-samples.ts` lines 26-32 + LoCoMo `evaluation.py:208-217` + ACL paper §4.1):**

| LoCoMo cat # | Label |
|---|---|
| 1 | multi-hop |
| 2 | temporal |
| 3 | open-ended (open-domain) |
| 4 | single-hop |
| 5 | adversarial — excluded from N=400 4-way split |

**Per-category recall@5:**

| Cat | n | recall@5 | Label |
|---|---|---|---|
| 1 | 32 | **0.500** | multi-hop |
| 2 | 37 | **0.919** | temporal |
| 3 | 13 | 0.545 | open-ended |
| 4 | 70 | **0.714** | single-hop |
| 5 | 47 | 0.723 | adversarial (excluded from 4-way) |
| **4-way total** | **152** | **0.681** | (single+multi+temporal+open-ended only) |
| **all scorable incl. adversarial** | **192** | **0.714** | reference |

The 4-way total (0.681) is the apples-to-apples comparable to V1's 22.25% (also 4-way). Distribution makes physical sense: temporal best (per-turn timestamps preserved via `createIFrame(createdAt)` paid off), multi-hop hardest (as expected), single-hop in the middle.

Methodology: deterministic floor metric. For each question, top-5 hits returned by `runRecallContext({scope:'current', workspace, limit:5, profile:'balanced', rerank:true})`. Recall=1 if any retrieved snippet's content includes a `dia:<id>` substring matching the question's `evidence` array.

---

## Why these numbers cannot be subtracted

**Three confounds mean today's 0.714 ≠ a delta against 22.25%:**

1. **Different metric layer.**
   - Theirs: end-to-end LLM-judge accuracy (retrieval → LLM → trio-strict scores the answer string).
   - Mine: deterministic retrieval recall (did the substrate surface a ground-truth-tagged turn?).
   - Recall@5 is an **upper bound** on end-to-end accuracy — a system that doesn't surface evidence cannot answer (if the answer requires that evidence).

2. **Different N + different conversation.**
   - Theirs: N=400 stratified across LoCoMo-1540 (all 10 conversations).
   - Mine: 199 questions from conv-26 (a single conversation, sample 0 of 10).
   - conv-26 is one slice, not a representative draw.

3. **Different substrate generation.**
   - V1 was pre-Phase-3 (no cross-encoder reranker, no semantic chunker, no 8k embedder, single-mind retrieval).
   - Today is post-Phase-3 (all four levers on, single-workspace scope=current via the A1-A4 fix landed yesterday).

---

## What we *can* say

- **V1's retrieval was the bottleneck.** 22.25% end-to-end with a 74% oracle ceiling = retrieval was leaving ~52pp on the table. The Phase 3 work (reranker + chunker + 8k embedder + per-workspace cognify) was the response.
- **Today's retrieval recall is meaningful but not yet comparable.** 0.714 evidence_recall@5 means **at most 71.4%** end-to-end accuracy is achievable on conv-26 (assuming the LLM can use the retrieved context; reality is below this ceiling). It does not directly say "we beat 22.25%."
- **The category split tells a real story.** Multi-hop (cat 2) at 0.919 outperforming single-hop (cat 1) at 0.500 is a **useful diagnostic** — it suggests the substrate's strength is dense-keyword multi-hop questions and its weakness is short, ambiguous lookup questions where lexical/semantic signal is thin.
- **Single-judge claude -p in Phase 5 will be inflated by ~+27pp** vs trio-strict, per the prior methodology finding. So a Phase 5 number ≠ a comparable end-to-end answer-accuracy number.

---

## What's needed for a like-for-like claim against V1's 22.25%

To say "post-Phase-3 substrate beats V1 retrieval on the apples-to-apples Stage 3 protocol":

1. **Same dataset slice.** Either the full LoCoMo-1540 or the same N=400 stratified sample selected by manifest v6. Conv-26-only is not enough.
2. **Same end-to-end pipeline.** Substrate retrieves → subject LLM (Qwen3.6-35B at thinking=off, 16K max_tokens, per Stage 3 ratification) generates an answer string.
3. **Same trio-strict judge ensemble.** Opus 4.6 + GPT-5 + MiniMax M2.7, ALL must agree.
4. **Pre-registered manifest** so post-hoc selection bias is excluded.

Estimated cost: ~$30 per cell (per the methodology doc) plus subject-model API spend.

---

## Three options for Phase 5+

**(a) Cheap path — single-judge claude -p, conv-26 only.**
Quick (~10–15 min). Produces a number, but **not directly comparable** to the prior 22.25% trio-strict measurement. Useful as an internal smoke test of the harness, not as a public claim.

**(b) Headline path — trio-strict, N=400 stratified.**
Apples-to-apples vs Stage 3 v6. ~$30 in judge calls + subject-model spend. Multi-hour runtime. Only path that produces a number that beats V1's 22.25% credibly.

**(c) Skip Phase 5 — keep recall@5 as the primary metric.**
Document the substrate's retrieval recall as the floor metric. Position as "retrieval bottleneck closed; end-to-end measurement deferred to Stage 4 or post-launch."

---

## Recommendation

**(c) for now → (b) when ready for the public claim.**

Rationale: Phase 5's single-judge LLM run produces a number that's noisy AND unscalable — it can't be compared to V1's trio-strict 22.25% without correcting for the +27pp methodology gap, which itself is an estimate. Better to either:
- Stop at retrieval recall (today's deliverable) and document the upper bound, OR
- Skip ahead to a proper trio-strict end-to-end run when the public claim is needed.

The middle path (single-judge end-to-end) gives a number, but a number that nobody can do anything with.

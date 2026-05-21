# LoCoMo Replay — Substrate Quality Validation

**Status:** Ready to build, 2026-05-08
**Scope:** Validate the post-handover substrate (reranker + semantic chunker + 8k embedder + per-workspace cognify) against an external benchmark.
**Path:** Single configuration, full stack on, 1 LoCoMo conversation, LLM-judge scoring via `claude -p`, CLI `recall-context` retrieval path (the only path with reranker wired).

---

## Why this benchmark, why now

Phase 3a/3b/3c shipped four post-handover quality levers (reranker, semantic chunker, 8k embedder, per-workspace cognify) without ever measuring them against an external dataset. We've eyeballed quality on three internal queries — that's not a number. LoCoMo gives us:

- **Public ground truth** — questions with reference answers and evidence-turn annotations
- **Long-form context** — ~600 turns per dialogue, much closer to a real CC session than our internal smoke tests
- **Category breakdown** — single-hop / multi-hop / temporal / open-domain / adversarial. We will see *where* the system falls over, not just an aggregate.

This is a **measurement run**, not an OSS release. Result is one number per category + a qualitative miss-list.

---

## Dataset

- Source: `snap-research/locomo` GitHub repo (HF dataset is gated; GitHub is open). File: `data/locomo10.json` on `main`.
- **Pinned URL:** `https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json`
- **Pinned git blob:** `d95b872480b413d935821fdc3c84f8a8f5f29e73` (~2.8 MB)
- Stored locally at `scripts/locomo/data/locomo10.json` (gitignored). Manifest with SHA256 at `scripts/locomo/data/MANIFEST.json`.

### Schema (verified 2026-05-08, Phase 0)

Top-level: **array of 10 conversations**. Each conversation:

```jsonc
{
  "sample_id": "conv-26",            // human label, e.g., conv-26 (NOT 0..9)
  "qa": [                            // 199 entries for conv 0; 1986 across all 10
    {
      "question": "What did Caroline research?",
      "answer":   "Adoption agencies",
      "evidence": ["D2:8"],          // array of dia_ids — anchors into session N's turns
      "category": "1"                // string "1"..."5"
    }
  ],
  "conversation": {                  // NOT a flat turn array — multi-session container
    "speaker_a": "Caroline",
    "speaker_b": "Melanie",
    "session_1_date_time": "...",    // session-level timestamp (e.g., "1:56 pm on 8 May, 2023")
    "session_1": [
      { "speaker": "Caroline", "dia_id": "D1:1", "text": "Hey Mel!..." },
      // ...
    ],
    "session_2_date_time": "...",
    "session_2": [...],
    // up to session_10 (varies per conversation)
  },
  "event_summary":   { ... },        // not used in this replay
  "observation":     { ... },        // not used
  "session_summary": { ... }         // not used
}
```

**Aggregate counts (all 10 convs):** 272 sessions, **5,882 turns**, **1,986 QAs**.

**Conv 0 (`conv-26`) specifically:** 10 sessions, ~180 turns, **199 QAs**.

### Implications for Phase 2 (ingest)

- One frame per turn. Session is *not* a frame — it's a grouping for timestamps.
- Frame prefix MUST include `dia_id` verbatim (e.g., `[locomo conv:0 dia:D1:3 ...]`) — this is the anchor for `evidence_recall@5`.
- Apply the **session's** `date_time` string to every turn in that session. Per-turn timestamps don't exist.
- Iterate sessions in numeric order: `session_1` → `session_2` → … → `session_N`. The keys aren't ordered lexically (`session_10` < `session_2` if string-sorted).

### Implications for Phase 5 (judge / recall@5)

- `evidence` is `string[]` of dia_ids. `evidence_recall@5 = retrieved_top5.some(snippet => evidence.some(e => snippet.includes(`dia:${e}`)))`.
- Category mapping (per LoCoMo paper, to verify in Phase 6 reporting):
  - `"1"` single-hop, `"2"` multi-hop, `"3"` temporal, `"4"` open-domain, `"5"` adversarial.
- Adversarial (`category="5"`) often has `answer:"undefined"` — the *correct* retrieval is "no relevant evidence found". Score these on a separate axis (refusal rate), don't average with recall.

---

## Architecture

```
┌──────────────────────────┐
│  scripts/locomo/run.mjs  │   single entrypoint, calls phases in order
└────────────┬─────────────┘
             │
   ┌─────────┼──────────┬─────────────┬─────────────┐
   ▼         ▼          ▼             ▼             ▼
 fetch    prepare-ws  ingest      cognify       query+score
   │         │          │             │             │
data/    workspace=  save_memory  --workspace=  runRecallContext()
loc10.   proj-       per turn     <id>          + claude -p judge
json     locomo-N                                     │
                                                      ▼
                                             results/run-<ts>.json
                                             RESULT-<ts>.md
```

**Workspace strategy:** dedicated `proj-locomo-<timestamp>` workspace. Never personal. Cleanup is `rm -rf ~/.hive-mind/workspaces/proj-locomo-<ts>` after the run.

**Library mode, not subprocess mode:** the driver imports `runRecallContext`, `runCognify`, and `MindEnv` from the dist build of `D:/Projects/hive-mind/packages/cli`. Avoids ~200 CLI cold-starts (~3-4s each on Windows = 10+ minutes saved).

---

## Phase plan (6 scripts, ~30-40 min wall clock)

| # | File | Purpose | Est. |
|---|------|---------|------|
| 0 | `scripts/locomo/00-fetch-dataset.mjs` | HTTP GET `snap-research/locomo10` JSON, save to `data/locomo10.json` | 5min |
| 1 | `scripts/locomo/01-prepare-workspace.mjs` | Create clean workspace `proj-locomo-<ts>`, write `RUN.json` with id+timestamp | 10min |
| 2 | `scripts/locomo/02-ingest-conversation.mjs <conv_idx>` | For each turn in conv N: `save_memory` to test workspace with content `[locomo conv:N turn:M speaker:S ts:T] {text}` | 30min build, 3min run |
| 3 | `scripts/locomo/03-cognify.mjs` | `runCognify({ workspace: 'proj-locomo-<ts>', fullRescan: true })` — produces chunks + embeddings + entities | 10min build, 3min run |
| 4 | `scripts/locomo/04-run-queries.mjs` | For each question in conv N's qa[]: `runRecallContext({ query, scope:'current', workspace: 'proj-locomo-<ts>', limit:5 })`. Save `{question, answer, evidence_turn_ids, category, retrieved}` JSONL | 30min build, ~5min run (200 queries × 1.5s) |
| 5 | `scripts/locomo/05-score.mjs` | For each row: spawn `claude -p` with judge prompt. Save 0/1 verdict + reason. Also compute `evidence_recall@5` (deterministic, free) as secondary metric | 30min build, ~10-15min run |
| 6 | `scripts/locomo/06-report.mjs` | Aggregate by category. Emit `RESULT-<ts>.md`: precision@5 (LLM-judge), evidence_recall@5, per-category breakdown, top-10 misses with reasoning | 20min build, ~30s run |

**run.mjs** chains 0→6 with `--skip-fetch` / `--start-from=N` flags so we can iterate on phase 5 without re-running 0-4.

---

## Frame format (turn → frame)

```
[locomo conv:0 turn:42 speaker:Alice ts:2023-04-15T18:32:11]
And then we drove to that little cafe near the marina —
the one with the blue awning. I had the eggs benedict.
```

- Turn ID and timestamp preserved in prefix for temporal queries
- Speaker preserved for multi-hop "who said X?" questions
- One frame per turn (not per dialogue) — keeps frame size small, lets reranker pick the right turn cleanly
- Importance: `temporary` (these are test frames, not real memories — easy to purge)
- Source: `system` with a marker `locomo_turn` so we can grep them later

---

## LLM-judge prompt (phase 5)

```
You are scoring whether a memory retrieval system surfaced enough
information to correctly answer a question.

Question: {question}
Reference answer: {answer}
System retrieved (top-5):
{retrieved_snippets}

Did the retrieval contain enough information to answer the question
correctly? Respond with EXACTLY one of:
  YES — <one sentence why>
  NO  — <one sentence why>
  PARTIAL — <one sentence why>
```

- Stdin → claude -p, parse first token of stdout for verdict
- ~3-5s per call. Windows-safe: `spawn('claude', args, { shell: true })` — known gotcha from prior session.
- Score: YES = 1.0, PARTIAL = 0.5, NO = 0.0

---

## Secondary metric: evidence_recall@5 (deterministic, free)

LoCoMo provides `evidence_turn_ids` per question — the turns that contain the answer. For each question:

```
hits = retrieved_top5.filter(snippet =>
  evidence_turn_ids.some(id => snippet.includes(`turn:${id}`)))
recall_at_5 = hits.length > 0 ? 1 : 0
```

This is a strict "did we surface AT LEAST ONE evidence turn?" floor. If evidence_recall@5 is high but LLM-judge is low, the bug is in *how the agent uses retrieved context*, not retrieval. If both are low, retrieval is the bug. This split is more diagnostic than either metric alone.

---

## Risk register

> **2026-05-08 update:** the workspace-scope leak risk has been **eliminated** by Phase A
> (runRecallContext now supports `scope:'current'` + `workspace:<id>`, so the LoCoMo
> driver gets clean single-workspace retrieval with no cross-pollution). Original entry
> kept for historical context.

| Risk | Mitigation |
|------|-----------|
| HuggingFace dataset URL changes | Pin to a specific commit hash in fetch script; store SHA256 of downloaded JSON |
| save_memory rate-limited by MCP | Use library mode — call `mind.save()` directly, no MCP |
| Cognify embedder hits Ollama rate limit | Already handled by `embedding-provider.ts` (per HANDOVER §3a-3); 600 frames is fine |
| `claude -p` rate-limited by CC subscription | Add 250ms sleep between judge calls; if 429 emerges, drop to 1/sec |
| LoCoMo turn timestamps fictional (year 2023 etc.) might confuse the system | Acceptable — we're testing whether the system can *use* the timestamp string, not match real-world time |
| Test workspace pollution if the run crashes mid-way | Phase 1 writes `RUN.json` with the workspace id; cleanup script reads it. `cleanup.mjs` for any/all `proj-locomo-*` ids |

---

## Success criteria for the harness (not the score)

1. End-to-end run produces `RESULT-<ts>.md` with category breakdown without manual intervention
2. Each phase has a `--dry-run` mode (no writes, no LLM calls) for debugging
3. Re-running phase 4 doesn't re-ingest conversation (workspace persists between phase runs)
4. Driver respects `HIVE_MIND_NO_SYNTH=1` so the LoCoMo ingestion doesn't spawn synth tasks against our test frames

---

## What we're NOT doing (yet)

- **No ablation** — single config, full stack on. If results are interesting, we run a 3-config ablation in a follow-up.
- **No MCP path benchmark** — CLI only. Benchmarking MCP separately would require wiring reranker into MCP first (see HANDOVER §gotchas).
- **No multi-conversation aggregation** — 1 conv first to prove the harness. Then we extend to 3 or 10.
- **No upstream PR** — this is a local measurement. Results may inform a follow-up upstream contribution but are not a blocker for one.

---

## Open parking lot (decide during build, not now)

- Should the LLM judge see the *question category* (single-hop vs multi-hop)? Probably no — bias risk. But if YES verdicts cluster suspiciously by category, revisit.
- Should we report position-weighted score (top-1 hit > top-5 hit)? Implement as a column, decide at report time.
- Should adversarial questions (where the answer is "not stated in the conversation") get scored at all, or only counted as a separate axis? Likely separate axis — they test refusal, not recall.

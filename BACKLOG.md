# hive-mind Backlog

Open work items queued against the hive-mind substrate. Each entry carries
a priority tag (P0 / P1 / P2) + acceptance pattern + explicit blocker
relationships.

Conventions:
- **P0** — blocks launch or active critical-path work.
- **P1** — blocks a specific downstream cycle (not launch).
- **P2** — quality / polish / hardening; no downstream blocker.
- Every item references the external doc or session log that originated it.

---

## P1 — Harvest Claude artifacts adapter

**Opened:** 2026-04-21 · **Ref:** `PM-Waggle-OS/sessions/2026-04-21-stage-0-final-close-out.md` §2 mechanism #3 + §6

### Scope

Extend the existing `ClaudeAdapter` in `@hive-mind/core/src/harvest/claude-adapter.ts` (or add a sibling `ClaudeArtifactsAdapter`) to cover artifact content — generated files Claude produces during sessions (`.md`, `.docx`, `.py`, charts, rendered documents, etc.) that are stored under `/mnt/user-data/outputs/` in Claude's file system and referenced in `conversations.json` as chat-turn hyperlinks of the form:

```
[View your editorial analysis document](computer:///mnt/user-data/outputs/Legat_Urednicka_Analiza.docx)
```

The referencing chat turn is captured by the current adapter; the **artifact content itself is not** in the Claude.ai `conversations.json` export.

### Verification step before implementation (mandatory first pass)

Do NOT implement the adapter before verifying what Claude.ai actually emits on export. Three possibilities, in order of preference:

1. **Claude.ai export already bundles the artifacts directory.** Marko triggers a fresh export (2026-04-21 timeframe or later), unzips, lists every file + folder at every level. If there's a sibling directory to `conversations.json` carrying the `/mnt/user-data/outputs/` contents (likely named `outputs/`, `artifacts/`, `generated/`, or similar), the adapter trivially picks them up.
2. **Claude.ai API offers an artifact-listing endpoint.** Check public API docs + internal Anthropic SDK surfaces for a `claude.conversations.<id>.artifacts.list()` equivalent. If present, a Node-side fetch loop can enumerate artifacts per conversation and re-download their content, producing the same shape as option (1).
3. **Computer Use scraping of the Claude.ai web UI.** Lowest preference — fragile, rate-limited, requires credential handling. Only viable if (1) and (2) both fail AND the business case for Marko's corpus coverage justifies the maintenance burden.

Verification output: a short doc (`hive-mind/docs/claude-artifacts-verification.md` or equivalent) recording which option is available, with a specific file-listing example from Marko's corpus showing artifact presence / absence.

### Acceptance pattern (post-verification, regardless of source path chosen)

Adapter must produce a `UniversalImportItem` of type `artifact` for each referenced artifact content, with:

- `id`: stable UUID (content-hash based so dedup at frame layer works on re-ingest).
- `source`: `'claude'` (same source tag as conversation items — they live in the same unified KG).
- `type`: `'artifact'` (distinguishes from `'conversation'` items that already exist).
- `title`: derived from the artifact filename + originating session title, e.g. `Legat_Urednicka_Analiza.docx (from: "Uredničke preporeke za Legat — Prva knjiga")`.
- `content`: the artifact's extracted text content (via existing PdfAdapter / MarkdownAdapter / docx extractor libraries depending on file type). For binary / non-text artifacts, stub the content with a descriptor line + don't crash the pipeline.
- `timestamp`: **same as the referencing chat turn's `created_at`**. This is the critical link — the artifact inherits the parent session's temporal anchor, which is the mechanism #3 fix. `item.timestamp` flows through the existing Task-0 substrate plumbing (commit `9ec75e6`).
- `metadata.parent_conversation_id`: the originating conversation's UUID, so retrieval can join artifact frames back to their originating chat.
- `metadata.parent_chat_turn_dia_id`: the specific chat turn that referenced the artifact (if multiple turns in one conversation link to the same artifact, earliest turn wins).

### Regression test requirements

- Fixture JSON with one conversation + two referenced artifacts (one `.md`, one `.docx`) + the corresponding artifact files — ingests to exactly 3 frames (1 conversation + 2 artifacts). Artifact frames carry `parent_conversation_id` + matching timestamps.
- Re-ingest the same export produces 0 new frames (dedup holds across conversation + artifact frames).
- Artifact whose referenced file is missing from export (broken link in `conversations.json`) does NOT crash the pipeline — ingests the conversation frame normally, logs a warn naming the missing artifact path, increments a `missing_artifacts` counter on the result.

### Relationships

- **NOT blocker for:** Sprint 9 Tasks 4/5 (PM-authored synthesized triples — no real corpus). Launch. Stage 1 / Stage 2 preflight on LoCoMo (public dataset, chat-text-only by construction). H-42 / H-43 / H-44 benchmark runs (same public-dataset rationale).
- **BLOCKS:** next dogfood cycle that tests artifact-bound anchors. Any Stage 0 re-run where the ground truth includes "what did you deliver in session X" and the deliverable was a generated file. Long-form generative tests on Marko's real corpus where the output lives in `/mnt/user-data/outputs/` and isn't re-stated in later chat prompts.
- **Depends on:** commits `9ec75e6` (harvest timestamp persistence — item.timestamp must flow through) and `0bbdf7a` (preview cap raise — artifact content will often be long; cap-or-no-cap decision for artifact frames is a sub-question worth splitting).

### Estimated effort

- If verification option (1) passes: 1-2 days implementation + tests.
- If option (2) needs the API path: 3-5 days including API auth + rate limit handling.
- If option (3) is the only viable path: 7-10 days + ongoing maintenance risk — this path is only worth pursuing if no alternative surfaces.

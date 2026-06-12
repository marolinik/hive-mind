// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
/**
 * recall-context.ts — shared renderer for surfacing temporal information in
 * recalled-memory blocks. Single source of truth imported by both the
 * production agent and the benchmark harness, so the injected-memory format
 * never drifts between the two.
 *
 * Scope (Temporal Substrate Fix, Phase 1 — "surface time", additive only):
 *  - Prefix each retrieved snippet with its own compact `[YYYY-MM-DD]` date.
 *  - Open the rendered memory block with one anchor line giving the most-recent
 *    memory date, so the model has a concrete "now" to resolve relative time
 *    expressions against.
 *  - Export `TEMPORAL_GUIDANCE`, the prompt fragment that tells the model to
 *    treat those timestamps as the anchor for relative-time arithmetic.
 *
 * Distilled "Memory Facts" (cross-session syntheses) are intentionally NOT
 * dated here — they have no single reliable date. Phase 2 handles them.
 */

/**
 * Prompt fragment wired into the memory-recall injection path (NOT the global
 * system prompt). Teaches the model to use the surfaced `[YYYY-MM-DD]` stamps
 * as the anchor for resolving relative time expressions and conflicting facts.
 *
 * Benchmark-proven wording: concrete relative-date arithmetic with worked
 * examples (Memori instruction-5 lineage, incl. the verified conv-26
 * "yesterday" failure case) plus the granularity-calibration clause (failure
 * mining: 22 temporal fails emitted a confident exact ISO day 1-7 days off
 * where a coarse answer was correct). Temporal was the #1 LoCoMo lever
 * (80.06 → 84.7 across W1-W3.1). Production-safe subset: no never-refuse
 * clause (that was benchmark-cell policy only — conditional abstention stays).
 */
export const TEMPORAL_GUIDANCE =
  "Memories and snippets are timestamped [YYYY-MM-DD]. Pay special attention to these " +
  "timestamps to determine timing. If a question involves relative time references " +
  "('last year', 'two months ago', 'yesterday', 'last week'), CALCULATE the actual date " +
  "from the timestamp of the memory that mentions it. For example: a memory dated " +
  "4 May 2022 that says 'went to India last year' means the trip was in 2021; a memory " +
  "dated 8 May 2023 that says 'I went to the group yesterday' means the event was 7 May 2023. " +
  "Always convert relative references to specific dates, months, or years using the " +
  "memory's timestamp as the anchor, and ignore the relative phrase itself when answering. " +
  "When the same fact appears at different times, the most recent version is correct. " +
  "GRANULARITY: state an exact day ONLY when that exact date was explicitly stated or " +
  "directly computed from an explicit relative reference; otherwise answer at the " +
  "granularity you are confident in — 'early June 2023', 'the week before 9 August 2023', " +
  "'August 2022'. A confidently wrong exact day is worse than a correct coarse answer. " +
  "For 'how long / how many months' duration questions, give ONLY the final value " +
  "(e.g. 'six months') — no intermediate dates, no reasoning steps.";

/** Anchor-line prefix for the most-recent rendered memory date. */
const REFERENCE_DATE_LABEL = 'Reference date (most recent memory):';

/**
 * Slice an ISO-ish timestamp to its `YYYY-MM-DD` date prefix. Returns null when
 * the value is missing or too short to carry a date.
 */
export function toDatePrefix(createdAt: string | null | undefined): string | null {
  if (!createdAt || createdAt.length < 10) return null;
  return createdAt.slice(0, 10);
}

/**
 * Render a single retrieved snippet with its compact `[YYYY-MM-DD]` date prefix.
 * `text` is the snippet text exactly as it would otherwise be rendered (the
 * caller owns importance labels, truncation, etc.); this only prepends the date.
 * Falls back to the bare text when the hit carries no usable timestamp.
 */
export function renderDatedSnippet(createdAt: string | null | undefined, text: string): string {
  const date = toDatePrefix(createdAt);
  return date ? `[${date}] ${text}` : text;
}

/**
 * Compute the reference (anchor) date: the maximum `created_at` among the
 * supplied timestamps, sliced to `YYYY-MM-DD`. Returns null when none carry a
 * usable date (caller then omits the anchor line).
 */
export function referenceDate(createdAts: ReadonlyArray<string | null | undefined>): string | null {
  let max: string | null = null;
  for (const c of createdAts) {
    const date = toDatePrefix(c);
    if (date && (max === null || date > max)) max = date;
  }
  return max;
}

/**
 * Build the single anchor line for a memory block, e.g.
 * `Reference date (most recent memory): 2026-06-09`. Returns null when no date
 * is available.
 */
export function renderReferenceDateLine(
  createdAts: ReadonlyArray<string | null | undefined>,
): string | null {
  const date = referenceDate(createdAts);
  return date ? `${REFERENCE_DATE_LABEL} ${date}` : null;
}

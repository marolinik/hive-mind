/**
 * Phase 3e-1 — Pre-execution failure pattern matching.
 *
 * Operates over an already-fetched `recall_memory` result set. We trust the
 * upstream HybridSearch ranking (FTS + vec0 fused via RRF, optional reranker)
 * to surface SEMANTICALLY related frames; this module's job is only to spot
 * when one of those semantically-close frames describes a past FAILURE the
 * current prompt is at risk of repeating.
 *
 * No new MCP call, no embedding access — just regex post-processing of a
 * recall that already happened. Cheap, fail-open.
 *
 * The 0.7 cosine-similarity threshold from the original Phase 3 plan doesn't
 * map cleanly onto RRF scores (which sit in the 0.001–0.05 range). Instead we
 * surface a failure pattern when it APPEARS IN THE TOP-N of the relevance
 * recall — being top-N implies semantic relevance to the prompt, regardless
 * of the absolute RRF score.
 */

const FAILURE_PATTERNS = [
  // Direct failure verbs / nouns
  /\b(failed|failure|broke|broken|crashed|crashing|crash(?!\w))\b/i,
  // Bug / regression tags
  /\b(bug|regression)\b/i,
  // Negation phrases
  /\b(did not|didn't|doesn't|wasn't|isn't|won't|hasn't|hadn't) work(ing|s|ed)?\b/i,
  /\bnot working\b/i,
  // Timeouts / hangs
  /\b(timed out|timeout|hung|hangs|hanged)\b/i,
  // Generic error markers in past-tense / present-tense problem state
  /\b(threw|throws|throwing) (an? )?error\b/i,
  /\b(blew up|blew-up)\b/i,
];

// Frames that mention failure terms but in a RESOLVED context — we don't want
// to warn the user about a fix they already shipped.
const RESOLVED_PATTERNS = [
  /\bbug fix(ed|es|ing)?\b/i,
  /\b(fixed|resolved|closed|patched|landed) (the )?bug\b/i,
  /\bregression test\b/i,
  /\bonce we (fixed|resolved|patched)\b/i,
  /\bafter the fix\b/i,
];

/**
 * Inspect a recall result list for frames whose content matches a failure
 * pattern. Returns at most `maxMatches` frames, preserving recall order
 * (which is relevance-ranked upstream).
 *
 * @param {Array<{id?:number, content?:string, created_at?:string, importance?:string, source?:string, score?:number, from?:string}>} recall
 * @param {{maxMatches?: number, scoreFloor?: number}} [opts]
 * @returns {Array<{frame:object, pattern:string}>}
 */
export function detectFailureMatches(recall, opts = {}) {
  const maxMatches = Number.isFinite(opts.maxMatches) ? opts.maxMatches : 2;
  // Optional RRF score floor — if caller wants to require a relevance minimum.
  // Default is permissive (0) since recall is already top-N relevance-sorted.
  const scoreFloor = Number.isFinite(opts.scoreFloor) ? opts.scoreFloor : 0;
  const hits = Array.isArray(recall) ? recall : [];
  const matches = [];

  for (const h of hits) {
    if (matches.length >= maxMatches) break;
    const score = typeof h.score === 'number' ? h.score : 0;
    if (score < scoreFloor) continue;
    const c = String(h.content || '');
    if (!c) continue;
    // Skip the user's own just-saved prompt frame — it would self-match if
    // the user types something like "X is broken, please fix".
    if (h.importance === 'temporary' && /^\[hm session:/.test(c)) continue;
    // Skip frames that describe a fix, not the failure itself.
    if (RESOLVED_PATTERNS.some((p) => p.test(c))) continue;
    const matched = FAILURE_PATTERNS.find((p) => p.test(c));
    if (matched) {
      matches.push({ frame: h, pattern: matched.source });
    }
  }
  return matches;
}

/**
 * Convenience: produce a list of frame ids that matched, suitable for
 * filtering them out of a separate recall section so they don't appear twice.
 *
 * @param {Array<{frame:{id?:number}}>} matches
 * @returns {Set<number>}
 */
export function failureFrameIds(matches) {
  const ids = new Set();
  for (const m of matches) {
    const id = m && m.frame && typeof m.frame.id === 'number' ? m.frame.id : null;
    if (id !== null) ids.add(id);
  }
  return ids;
}

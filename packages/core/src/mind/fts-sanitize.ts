/**
 * fts-sanitize.ts — shared FTS5 OR-query sanitizer (S1 Unicode fix).
 *
 * One canonical copy of the sanitizer previously duplicated in
 * HybridSearch.keywordSearch (W3.6) and raw-detail-lane's ftsOrQuery. The old
 * `[^\w]` strip removed EVERY non-ASCII letter — a Cyrillic ("Београд") or
 * diacritic (č/ž/š/đ) query sanitized to an empty MATCH string and keyword
 * recall silently returned [] even though the unicode61 FTS5 tokenizer handles
 * those scripts fine. Fixed with the Unicode-aware class `[^\p{L}\p{N}_]`,
 * which is a no-op for pure-ASCII input (`\w` ⊂ `\p{L}\p{N}_`), so English
 * MATCH strings — and therefore results and scores — are byte-identical to
 * before.
 *
 * CJK tokens (Han/Hiragana/Katakana/Hangul) are deliberately EXCLUDED from
 * the OR query: unicode61 does not segment those scripts, so contiguous
 * prose is indexed as one long token and a per-word MATCH almost never
 * hits — the query "succeeds" with zero rows, which would also block any
 * parse-error fallback. Dropping CJK tokens leaves the OR query empty for
 * pure-CJK input; callers with a LIKE fallback (HybridSearch.keywordSearch)
 * detect that via `hasUnsegmentedScript` and use substring matching, which
 * is reliable for unsegmented text. This also sidesteps the `length > 2`
 * filter, which would have dropped typical 1–2 char CJK words. Other
 * unsegmented scripts (Thai, Khmer, Lao, …) can be added to
 * UNSEGMENTED_SCRIPT_RE if those markets materialize.
 */

export const FTS_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'this',
  'that', 'these', 'those', 'it', 'its', 'my', 'your', 'our', 'their',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'all',
  'each', 'every', 'both', 'some', 'any', 'no', 'not', 'and', 'or', 'but',
]);

/** Strip everything that is not a Unicode letter, digit, or underscore. */
export function sanitizeFtsToken(word: string): string {
  return word.replace(/[^\p{L}\p{N}_]/gu, '');
}

const UNSEGMENTED_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** True when the text contains a script unicode61 cannot word-segment (CJK). */
export function hasUnsegmentedScript(text: string): boolean {
  return UNSEGMENTED_SCRIPT_RE.test(text);
}

/**
 * Build an OR-based FTS5 MATCH string: tokenize on whitespace, strip
 * punctuation (Unicode-aware), drop stop words / tokens ≤ 2 chars / CJK
 * tokens, quote each survivor. Returns '' when nothing survives — callers
 * treat that as "no FTS signal" (and may route CJK queries to a LIKE
 * fallback, see module doc).
 */
export function buildFtsOrQuery(query: string): string {
  return query
    .split(/\s+/)
    .map(sanitizeFtsToken)
    .filter(w => w.length > 2 && !FTS_STOP_WORDS.has(w.toLowerCase()) && !hasUnsegmentedScript(w))
    .map(w => `"${w}"`)
    .join(' OR ');
}

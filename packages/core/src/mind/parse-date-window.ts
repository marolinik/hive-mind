// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
/**
 * parse-date-window.ts — deterministic query-side temporal-constraint parser
 * (production port of the benchmark-proven Wave-3.1 date-window lane;
 * MRAG arXiv:2412.15540 pattern).
 *
 * When a query names an explicit period — "the last week of October 2023",
 * "early June 2023", "on 9 August 2023", "May 2023", "in 2022" — return a
 * `[since..until]` window (date-only `YYYY-MM-DD` bounds, inclusive) plus a
 * human label. Callers pass the window to HybridSearch's since/until filter;
 * the label feeds the future Events-during-X render section.
 *
 * Deterministic regex date math only — no LLM call, no new index. Returns
 * null when the query carries no explicit period (relative phrases like
 * "last week" / "two months ago" are resolution work for the WRITE side —
 * resolve-relative-date.ts — not query windowing).
 *
 * Regex shapes are byte-equivalent to the benchmark parser validated on the
 * full N=1540 LoCoMo run (wave3a); only types/docs differ.
 */

/** Inclusive date-only window parsed from an explicit period in a query. */
export interface DateWindow {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  since: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  until: string;
  /** Human-readable label of the matched period (for render sections). */
  label: string;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december)';

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse an explicit-period temporal constraint out of a query. Returns null
 * when no explicit period is named.
 */
export function parseDateWindow(query: string): DateWindow | null {
  const t = String(query).toLowerCase();

  // "first|second|third|fourth|last week of <month> <year>"
  let m = t.match(new RegExp(`(first|second|third|fourth|last)\\s+week\\s+of\\s+${MONTH_RE}\\s+(\\d{4})`));
  if (m) {
    const y = parseInt(m[3], 10), mo = MONTHS[m[2]];
    const last = lastDayOfMonth(y, mo);
    const ranges: Record<string, [number, number]> = {
      first: [1, 7], second: [8, 14], third: [15, 21], fourth: [22, 28],
      last: [Math.max(1, last - 6), last],
    };
    const [d1, d2] = ranges[m[1]];
    return { since: isoOf(y, mo, d1), until: isoOf(y, mo, Math.min(d2, last)), label: `the ${m[1]} week of ${m[2]} ${y}` };
  }

  // "early|mid|late <month> <year>"
  m = t.match(new RegExp(`(early|mid|late)\\s+${MONTH_RE}\\s+(\\d{4})`));
  if (m) {
    const y = parseInt(m[3], 10), mo = MONTHS[m[2]];
    const last = lastDayOfMonth(y, mo);
    const ranges: Record<string, [number, number]> = { early: [1, 10], mid: [11, 20], late: [21, last] };
    const [d1, d2] = ranges[m[1]];
    return { since: isoOf(y, mo, d1), until: isoOf(y, mo, d2), label: `${m[1]} ${m[2]} ${y}` };
  }

  // "<day> <month> <year>" or "<month> <day>, <year>" → exact-day ±2 buffer
  m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?\\s+(\\d{4})`)) ||
      t.match(new RegExp(`${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`));
  if (m) {
    const isDayFirst = /^\d/.test(m[1]);
    const day = parseInt(isDayFirst ? m[1] : m[2], 10);
    const mo = MONTHS[isDayFirst ? m[2] : m[1]];
    const y = parseInt(m[3], 10);
    if (mo && day >= 1 && day <= 31) {
      const center = Date.UTC(y, mo - 1, day);
      const lo = new Date(center - 2 * 86400000), hi = new Date(center + 2 * 86400000);
      return {
        since: lo.toISOString().slice(0, 10),
        until: hi.toISOString().slice(0, 10),
        label: `${day} ${isDayFirst ? m[2] : m[1]} ${y}`,
      };
    }
  }

  // "<month> <year>" → whole month
  m = t.match(new RegExp(`${MONTH_RE}\\s+(\\d{4})`));
  if (m) {
    const y = parseInt(m[2], 10), mo = MONTHS[m[1]];
    return { since: isoOf(y, mo, 1), until: isoOf(y, mo, lastDayOfMonth(y, mo)), label: `${m[1]} ${y}` };
  }

  // bare "in|during <year>" → whole year ('in'/'during' required so years
  // inside names/ids don't window the query)
  m = t.match(/\b(?:in|during)\s+(20\d{2})\b/);
  if (m) {
    const y = m[1];
    return { since: `${y}-01-01`, until: `${y}-12-31`, label: y };
  }

  return null;
}

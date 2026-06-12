// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
/**
 * resolve-relative-date — write-time relative-date resolution for the memory substrate.
 *
 * WHY THIS EXISTS (benchmark-validated, LoCoMo head-to-head vs Memori, 2026-06-10):
 * A conversation utterance's *discussion date* (when it was said) is not the same as
 * the *event date* (when the thing happened). "I went to the group yesterday" said on
 * 2023-05-08 describes an event on 2023-05-07. Storing the discussion date makes
 * "when did X happen?" questions wrong by the relative-reference delta — the verified
 * root cause of our temporal-category gap. Resolving the relative reference against the
 * source date at WRITE time bakes the correct event date into the frame's timestamp,
 * which lifted the LoCoMo temporal category to parity with Memori (80.06 vs 80.37).
 *
 * This is the deterministic, dependency-free production counterpart of the benchmark's
 * LLM extraction pass. It covers the dominant cue patterns the calibration surfaced
 * ("yesterday", "last week", "N days ago", "last <weekday>", "last year") without a
 * per-frame LLM call. Pure + side-effect free; the caller decides whether to use the
 * resolved date.
 */

/** A resolved relative-date hit: the matched cue phrase + the absolute ISO date (YYYY-MM-DD). */
export interface ResolvedDate {
  /** The relative cue that matched, e.g. "yesterday", "last week", "3 months ago". */
  cue: string;
  /** The resolved absolute date as YYYY-MM-DD. */
  iso: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** Parse an ISO-ish reference date (date or datetime) into a UTC Date at midnight. Null if unparseable. */
function parseReference(referenceDate: string | null | undefined): Date | null {
  if (!referenceDate || !ISO_DATE.test(referenceDate)) return null;
  const [y, m, d] = referenceDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Format a UTC Date as YYYY-MM-DD. */
function toIso(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

function addDays(dt: Date, n: number): Date {
  const out = new Date(dt.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function addMonths(dt: Date, n: number): Date {
  const out = new Date(dt.getTime());
  const targetMonthDay = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + n);
  // Clamp to the last valid day of the resulting month (e.g. Jan 31 − 1mo → Dec 31, not overflow).
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(targetMonthDay, lastDay));
  return out;
}

function addYears(dt: Date, n: number): Date {
  const out = new Date(dt.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + n);
  return out;
}

/** Most recent occurrence of `weekday` strictly before the reference date (the "last Friday" sense). */
function lastWeekday(dt: Date, weekday: number): Date {
  let delta = dt.getUTCDay() - weekday;
  if (delta <= 0) delta += 7; // strictly before → at least 1 day back
  return addDays(dt, -delta);
}

/**
 * Resolve the first relative-time cue in `text` against `referenceDate` (the source/
 * conversation date) into an absolute YYYY-MM-DD. Returns null when there is no
 * recognised cue or the reference date is unusable — the caller then keeps the
 * reference date as-is.
 *
 * Patterns are tried most-specific first so "the day before yesterday" wins over
 * "yesterday", and explicit "N units ago" wins over the bare "last unit".
 */
export function resolveRelativeDate(
  text: string,
  referenceDate: string | null | undefined,
): ResolvedDate | null {
  const ref = parseReference(referenceDate);
  if (!ref || !text) return null;
  const t = text.toLowerCase();

  // Most-specific day offsets first.
  if (/\bday before yesterday\b/.test(t)) return { cue: 'the day before yesterday', iso: toIso(addDays(ref, -2)) };
  if (/\byesterday\b/.test(t)) return { cue: 'yesterday', iso: toIso(addDays(ref, -1)) };

  // "N days/weeks/months/years ago" (explicit count).
  const ago = t.match(/\b(\d{1,3})\s+(day|week|month|year)s?\s+ago\b/);
  if (ago) {
    const n = parseInt(ago[1], 10);
    const unit = ago[2];
    const iso =
      unit === 'day' ? toIso(addDays(ref, -n)) :
      unit === 'week' ? toIso(addDays(ref, -7 * n)) :
      unit === 'month' ? toIso(addMonths(ref, -n)) :
      toIso(addYears(ref, -n));
    return { cue: `${n} ${unit}${n === 1 ? '' : 's'} ago`, iso };
  }

  // "a week/month/year ago" (singular, count = 1).
  const aAgo = t.match(/\ba\s+(week|month|year)\s+ago\b/);
  if (aAgo) {
    const unit = aAgo[1];
    const iso = unit === 'week' ? toIso(addDays(ref, -7)) : unit === 'month' ? toIso(addMonths(ref, -1)) : toIso(addYears(ref, -1));
    return { cue: `a ${unit} ago`, iso };
  }

  // "last <weekday>" → most recent prior occurrence of that weekday.
  const lastDow = t.match(/\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (lastDow) {
    const wd = WEEKDAYS.indexOf(lastDow[1] as (typeof WEEKDAYS)[number]);
    return { cue: `last ${lastDow[1]}`, iso: toIso(lastWeekday(ref, wd)) };
  }

  // "last week/month/year" (bare, coarse offset).
  if (/\blast\s+week\b/.test(t)) return { cue: 'last week', iso: toIso(addDays(ref, -7)) };
  if (/\blast\s+month\b/.test(t)) return { cue: 'last month', iso: toIso(addMonths(ref, -1)) };
  if (/\blast\s+year\b/.test(t)) return { cue: 'last year', iso: toIso(addYears(ref, -1)) };

  return null;
}

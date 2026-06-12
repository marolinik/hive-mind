/**
 * Raw external export shapes — loosely-typed structures as they arrive from
 * third-party JSON exports (ChatGPT / Claude / Gemini / generic).
 *
 * These adapters parse UNTRUSTED external data, so every field is optional and
 * widened. Property access goes through the narrowing helpers below rather than
 * casting to `any`, so a malformed export degrades to "skip" instead of throwing.
 *
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 */

/** A JSON object whose keys are unknown until narrowed. */
export type RawRecord = Record<string, unknown>;

/** Narrow an unknown value to a plain object, or null. */
export function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

/** Read a string property, or undefined if absent / wrong type. */
export function getString(obj: RawRecord, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a number property, or undefined if absent / wrong type. */
export function getNumber(obj: RawRecord, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

/** Read an array property as unknown[], or undefined if absent / wrong type. */
export function getArray(obj: RawRecord, key: string): unknown[] | undefined {
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

/** First defined string among the given keys (export shapes vary). */
export function firstString(obj: RawRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = getString(obj, key);
    if (v !== undefined) return v;
  }
  return undefined;
}

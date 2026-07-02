/**
 * stable-id.ts — deterministic, collision-safe id for harvest import items.
 *
 * WHY: a harvest item's `id` becomes the GDPR Art.17 subject key. The pipeline
 * runs it through `rawTurnConvKey → sanitizeToken(`${source}-${id}`, 64)`
 * (raw-turns.ts) to form `source_ref`, the key the erasure path reconstructs
 * from (source, source_ref) alone. `randomUUID()` mints a fresh id every
 * re-import, so a re-imported conversation lands under a NEW source_ref and
 * "sticky erasure" (erase-once-stays-erased across re-import) silently breaks.
 * A deterministic id keyed on the export's OWN stable identifiers fixes this —
 * and makes raw_archive idempotent across re-imports of the same subject.
 *
 * CONTRACT:
 *  - deterministic: same (source, ...parts) -> same id, forever, cross-process.
 *  - sanitize-stable: output is lowercase sha256 hex ([0-9a-f]) only, so it
 *    survives sanitizeToken(...,64) unchanged (no '-' collapse, no truncation
 *    collision within the 64-char budget).
 *  - collision-safe: a NUL ('\x00') separator between parts prevents field-
 *    boundary ambiguity (e.g. 'a' + 'bc' vs 'ab' + 'c'); NUL cannot appear in
 *    any real title/id/path, so it is an unambiguous delimiter. Undefined parts
 *    collapse to '' but STILL emit a separator, so a present-vs-absent field
 *    never aliases a shifted field.
 *  - never keys on growing content: callers pass stable identifiers (conv uuid,
 *    file path, map key) so a conversation that GAINS turns keeps its id.
 *
 * Reference impl: mind/content-hash.ts (same createHash('sha256') pattern).
 */
import { createHash } from 'node:crypto';

/**
 * Deterministic short id for a harvest item.
 *
 * @param source  the ImportSourceType discriminator (e.g. 'chatgpt') — the first
 *                hashed field, so ids from different adapters that share an
 *                otherwise-identical key can never collide.
 * @param parts   the stable identity fields. string|number|undefined accepted;
 *                number is stringified, undefined becomes '' (separator still
 *                emitted). At least one meaningful part SHOULD be passed.
 * @returns 40-char lowercase hex (sanitizeToken-stable, well under the 64 cap).
 */
export function stableHarvestId(
  source: string,
  ...parts: ReadonlyArray<string | number | undefined>
): string {
  // NUL-join: source is field 0; every part gets its own field even when ''.
  const key = [source, ...parts.map(p => (p === undefined ? '' : String(p)))].join('\x00');
  return createHash('sha256').update(key).digest('hex').slice(0, 40);
}

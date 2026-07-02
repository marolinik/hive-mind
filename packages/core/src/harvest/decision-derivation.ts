/**
 * decision-derivation.ts — the single source of truth for claude-code's derived
 * `decision-of` subject key.
 *
 * claude-code harvest (claude-code-adapter extractDecisions) fans a scanned item
 * out into a SEPARATE "Decisions from: …" item that quotes the parent's decision
 * lines. That derived item lands as its OWN GDPR Art.17 subject, keyed on
 * decisionOfSubjectId(parentId). Two layers must agree on that key EXACTLY:
 *   - the adapter, which MINTS the derived item's id at harvest time;
 *   - MindErasure.eraseBySourceRef, which RECOMPUTES it to erase + suppress the
 *     derived subject when the parent is erased (else it survives erasure and
 *     re-materializes on re-import — the #7 P2 gap).
 * Duplicating the derivation across those two sites is precisely the drift that
 * created the gap, so both import from here. Changing the token also invalidates
 * every already-persisted derived subject id, so treat it as a data contract.
 */
import { stableHarvestId } from './stable-id.js';

/** The only harvest source that derives a separate `decision-of` subject. */
export const CLAUDE_CODE_DECISION_SOURCE = 'claude-code';
/** The derivation-kind token the derived id is namespaced under. */
export const DECISION_OF_KIND = 'decision-of';

/**
 * Deterministic id for the `decision-of` subject derived from a claude-code
 * parent item. `parentId` is the parent's stable harvest id (== its raw_archive
 * source_ref), so the id is stable across re-imports of the same parent.
 */
export function decisionOfSubjectId(parentId: string): string {
  return stableHarvestId(CLAUDE_CODE_DECISION_SOURCE, DECISION_OF_KIND, parentId);
}

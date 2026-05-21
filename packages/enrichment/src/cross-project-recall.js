/**
 * Phase 3e-2 — Cross-project learning.
 *
 * The MCP `recall_memory` tool already supports `scope: 'all'` (personal
 * + every workspace). The default ranking sorts purely by relevance score,
 * which can let a marginal hit from an unrelated workspace bury a more
 * useful hit from the current workspace.
 *
 * This module post-processes a recall result list and SEPARATES it into:
 *   - inProject:    frames from `personal` or the current workspace
 *   - crossProject: frames from OTHER workspaces (downweight + highlight)
 *
 * The crossProject hits are rendered in their own callout ("by the way,
 * you solved this in proj-X earlier") so the user notices them without
 * losing the in-project context to a louder cross-project hit.
 *
 * Cognitively: this is the "cross-pollination" UX — the system tells you
 * what you've learned ELSEWHERE that might apply HERE, without overriding
 * the local context that's most likely to be relevant.
 */

const CROSS_PROJECT_DOWNWEIGHT = 0.5;
const FROM_WORKSPACE_RX = /^workspace:(.+)$/;

/**
 * Extract the workspace id from the recall hit's `from` marker.
 * Returns 'personal' for personal-mind hits, the workspace id for
 * `workspace:<id>` hits, or null if the marker is missing/unrecognized.
 *
 * @param {{from?: string}} hit
 * @returns {string|null}
 */
function fromWorkspaceId(hit) {
  if (!hit || typeof hit.from !== 'string') return null;
  if (hit.from === 'personal') return 'personal';
  const m = hit.from.match(FROM_WORKSPACE_RX);
  return m ? m[1] : null;
}

/**
 * Split a recall list into in-project vs cross-project hits.
 *
 * @param {Array<{from?:string, score?:number}>} recall
 * @param {string|null|undefined} currentWorkspaceId
 * @param {{maxCrossProject?: number, downweight?: number}} [opts]
 * @returns {{inProject: Array, crossProject: Array}}
 */
export function splitCrossProjectHits(recall, currentWorkspaceId, opts = {}) {
  const hits = Array.isArray(recall) ? recall : [];
  const maxCrossProject = Number.isFinite(opts.maxCrossProject) ? opts.maxCrossProject : 2;
  const downweight = Number.isFinite(opts.downweight) ? opts.downweight : CROSS_PROJECT_DOWNWEIGHT;

  // No current workspace context (e.g. CWD outside any workspace dir):
  // every hit is "in-project" by default. Cross-project rendering is
  // workspace-aware — without a workspace anchor, there's no concept of
  // "other workspaces."
  if (!currentWorkspaceId || currentWorkspaceId === 'personal') {
    return { inProject: hits.slice(), crossProject: [] };
  }

  const inProject = [];
  const crossProject = [];

  for (const h of hits) {
    const ws = fromWorkspaceId(h);
    // Personal frames belong with the in-project context — they're
    // identity / cross-cutting facts, not "another project's lessons."
    const isInProject = ws === null || ws === 'personal' || ws === currentWorkspaceId;
    if (isInProject) {
      inProject.push(h);
    } else {
      // Apply downweight by tagging the result with an adjusted score.
      // We don't mutate the input — return a shallow copy with the
      // adjusted score so callers (e.g. composer rendering) can choose
      // to display either the raw or adjusted value.
      const score = typeof h.score === 'number' ? h.score : 0;
      crossProject.push({
        ...h,
        crossProjectScore: score * downweight,
        crossProjectFrom: ws,
      });
    }
  }

  // Sort cross-project by adjusted score, take top N.
  crossProject.sort((a, b) => (b.crossProjectScore || 0) - (a.crossProjectScore || 0));

  return {
    inProject,
    crossProject: crossProject.slice(0, maxCrossProject),
  };
}

/**
 * Composes a 4-section context block.
 * Sections with no content are omitted entirely.
 */
import { getTier } from './frame-caps.js';

const PER_HIT_BUDGET = 240;

function fmtRecallHit(h) {
  const ts = h.created_at || h.createdAt || '';
  const importance = h.importance || 'normal';
  const content = String(h.content || '');
  const trimmed = content.length > PER_HIT_BUDGET ? content.slice(0, PER_HIT_BUDGET) + '…' : content;
  return `- (${importance}) ${ts}: ${trimmed}`;
}

function asArray(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === 'object' && Array.isArray(x.items)) return x.items;
  return [];
}

function formatProject(project) {
  if (!project) return '';
  const lines = [];
  if (project.name) lines.push(`Project: ${project.name}`);
  if (project.id) lines.push(`Workspace: ${project.id}`);
  if (Array.isArray(project.recentDecisions) && project.recentDecisions.length > 0) {
    lines.push('Recent decisions:');
    for (const d of project.recentDecisions.slice(0, 5)) {
      lines.push(`  - ${d}`);
    }
  }
  return lines.join('\n').trim();
}

function formatIdentity(identity, cap) {
  const items = asArray(identity);
  if (items.length === 0 && identity && typeof identity === 'object') {
    // identity may be an object of fields
    const entries = Object.entries(identity)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .slice(0, cap);
    return entries.map(([k, v]) => `- ${k}: ${v}`).join('\n');
  }
  return items
    .slice(0, cap)
    .map((it) => {
      if (typeof it === 'string') return `- ${it}`;
      const label = it.key || it.label || it.name || '';
      const val = it.value || it.content || '';
      return label ? `- ${label}: ${val}` : `- ${val}`;
    })
    .join('\n');
}

function formatAwareness(awareness, cap) {
  const items = asArray(awareness);
  return items
    .slice(0, cap)
    .map((it) => {
      if (typeof it === 'string') return `- ${it}`;
      const label = it.label || it.topic || it.key || '';
      const val = it.value || it.content || it.note || '';
      return label ? `- ${label}: ${val}` : `- ${val}`;
    })
    .join('\n');
}

function formatRecall(recall, cap) {
  const hits = asArray(recall);
  return hits.slice(0, cap).map(fmtRecallHit).join('\n');
}

/**
 * Last-activity bullets are workspace-scoped and sorted recency-desc upstream.
 * Renders a tighter format than `formatRecall` — meant to read like a "what
 * were you doing last" greeting, not a topical brief.
 */
function formatLastActivity(activity, cap) {
  const hits = asArray(activity);
  if (hits.length === 0) return '';
  // dedup by content prefix to avoid showing 3 near-identical hook frames
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const c = String(h.content || '');
    const key = c.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const ts = h.created_at || h.createdAt || '';
    const trimmed = c.length > PER_HIT_BUDGET ? c.slice(0, PER_HIT_BUDGET) + '…' : c;
    out.push(`- ${ts}: ${trimmed}`);
    if (out.length >= cap) break;
  }
  return out.join('\n');
}

/**
 * Renders top wiki page hits as a compact "you've documented these" section.
 * Each hit includes name + page type + source count so the LLM can decide
 * which to dig into via the get_page MCP tool. We don't inline content here
 * to keep the additionalContext budget small.
 */
function formatWikiContext(wiki, cap) {
  const items = asArray(wiki);
  if (items.length === 0) return '';
  return items
    .slice(0, cap)
    .map((p) => {
      const name = p.name || p.slug || 'unnamed';
      const slug = p.slug ? ` \`${p.slug}\`` : '';
      const type = p.type || p.page_type || 'page';
      const sources = p.sources ?? p.source_count;
      const meta = sources ? ` · ${sources} sources` : '';
      return `- **${name}**${slug} (${type}${meta})`;
    })
    .join('\n');
}

/**
 * Phase 3e-1 — render the failure-pattern callout.
 *
 * `failurePatterns` is the array returned by `detectFailureMatches` (see
 * failure-recall.js). When non-empty, surface as a high-priority section
 * AHEAD of regular recall so the LLM notices before composing a response.
 *
 * The wording is deliberately conservative — the heuristic regex matcher
 * has false positives, so we frame this as "worth checking" rather than
 * "you will fail." Saves the user from mistaking a noisy match for an
 * authoritative warning.
 */
function formatFailurePatterns(failurePatterns) {
  const items = asArray(failurePatterns);
  if (items.length === 0) return '';
  return items
    .map((m) => {
      const f = m && m.frame ? m.frame : {};
      const c = String(f.content || '');
      const trimmed = c.length > PER_HIT_BUDGET ? c.slice(0, PER_HIT_BUDGET) + '…' : c;
      const ts = f.created_at || f.createdAt || '';
      const where = f.from ? ` (${f.from})` : '';
      return `- ${ts}${where}: ${trimmed}`;
    })
    .join('\n');
}

/**
 * Phase 3e-2 — render cross-project "by the way" hits as a discrete section.
 *
 * Renders frames that came from OTHER workspaces, so the user sees what they
 * learned ELSEWHERE that might apply here. Distinct from regular `recall`
 * (which stays in-project) and from the failure-pattern callout (which is
 * a warning, not a hint).
 */
function formatCrossProjectHits(hits) {
  const items = asArray(hits);
  if (items.length === 0) return '';
  return items
    .map((h) => {
      const ts = h.created_at || h.createdAt || '';
      const where = h.crossProjectFrom || '';
      const c = String(h.content || '');
      const trimmed = c.length > PER_HIT_BUDGET ? c.slice(0, PER_HIT_BUDGET) + '…' : c;
      const src = where ? ` _(from ${where})_` : '';
      return `- ${ts}${src}: ${trimmed}`;
    })
    .join('\n');
}

/**
 * Phase 3e-3 — render decision-archaeology hits.
 *
 * When the prompt is a "why" question, surface the rule + Why + How-to-apply
 * lines from any feedback memory that overlapped on keywords. Renders as a
 * dedicated section so the LLM sees the rationale alongside the rule, not
 * buried in raw recall.
 */
function formatDecisionMatches(matches) {
  const items = asArray(matches);
  if (items.length === 0) return '';
  return items
    .map((m) => {
      const head = m.name ? `**${m.name}**` : 'Past decision';
      const desc = m.description ? `\n  _${m.description}_` : '';
      const why = m.why ? `\n  **Why:** ${m.why.length > PER_HIT_BUDGET ? m.why.slice(0, PER_HIT_BUDGET) + '…' : m.why}` : '';
      const how = m.howToApply ? `\n  **How to apply:** ${m.howToApply.length > PER_HIT_BUDGET ? m.howToApply.slice(0, PER_HIT_BUDGET) + '…' : m.howToApply}` : '';
      return `- ${head}${desc}${why}${how}`;
    })
    .join('\n');
}

/**
 * Phase 3e-4 — render contradiction warnings.
 *
 * Each item is a heuristic match between a "don't X" rule in a saved
 * feedback memory and the current prompt. Wording is intentionally a
 * check, not a block — the heuristic has false positives and the user
 * always retains override.
 */
function formatContradictions(contradictions) {
  const items = asArray(contradictions);
  if (items.length === 0) return '';
  return items
    .map((c) => {
      const head = c.name ? `**${c.name}**` : 'Saved rule';
      const overlap = Array.isArray(c.overlapTokens) && c.overlapTokens.length > 0
        ? ` _(matched on: ${c.overlapTokens.slice(0, 4).join(', ')})_`
        : '';
      const rule = c.rule
        ? c.rule.length > PER_HIT_BUDGET
          ? c.rule.slice(0, PER_HIT_BUDGET) + '…'
          : c.rule
        : '';
      return `- ${head}${overlap}\n  ${rule.replace(/\n+/g, ' ').trim()}`;
    })
    .join('\n');
}

/**
 * @param {{recall?:any, identity?:any, awareness?:any, project?:any, lastActivity?:any, wikiContext?:any, failurePatterns?:any, crossProjectHits?:any, decisionMatches?:any, contradictions?:any, tier?:string}} input
 * @returns {string}
 */
export function composeContext({ recall, identity, awareness, project, lastActivity, wikiContext, failurePatterns, crossProjectHits, decisionMatches, contradictions, tier } = {}) {
  const caps = getTier(tier);
  const sections = [];

  const projectText = formatProject(project);
  if (projectText) {
    sections.push(`## Project context\n${projectText}`);
  }

  const identityText = formatIdentity(identity, caps.identity);
  if (identityText) {
    sections.push(`## You should know about me\n${identityText}`);
  }

  const awarenessText = formatAwareness(awareness, caps.awareness);
  if (awarenessText) {
    sections.push(`## Active focus\n${awarenessText}`);
  }

  // 3e-4 — contradiction warning. Placed at the very top of the
  // additional context so the LLM (and the user, since hookSpecificOutput
  // is shown in the transcript) sees it before any other recall content.
  // Heuristic matcher; framed as "check, don't block."
  const contradictionText = formatContradictions(contradictions);
  if (contradictionText) {
    sections.push(
      `## Possible contradiction with a saved rule\n` +
        `_You previously saved a feedback memory whose rule overlaps your prompt's keywords. Worth confirming before proceeding._\n` +
        `${contradictionText}`
    );
  }

  // 3e-1 — heads-up about past failure patterns. Placed early so the LLM
  // notices BEFORE composing the response. Soft warning; heuristic regex
  // matcher has false positives, so phrasing is "worth checking" not
  // "you will fail."
  const failureText = formatFailurePatterns(failurePatterns);
  if (failureText) {
    sections.push(
      `## Heads-up — semantically similar past issue\n` +
        `_You've previously hit something that looks related. Worth a glance before proceeding._\n` +
        `${failureText}`
    );
  }

  // 3e-3 — decision archaeology. Only fires when the prompt is a "why"
  // question and a matching feedback memory exists. Surfaces the rule +
  // Why + How-to-apply lines so the answer is grounded in saved rationale.
  const decisionText = formatDecisionMatches(decisionMatches);
  if (decisionText) {
    sections.push(
      `## Past decision rationale\n` +
        `_Feedback memories whose rules/descriptions overlap your question._\n` +
        `${decisionText}`
    );
  }

  const lastActivityText = formatLastActivity(lastActivity, 3);
  if (lastActivityText) {
    const wsLabel = project && project.id ? ` in **${project.id}**` : '';
    sections.push(`## Last activity${wsLabel}\n${lastActivityText}`);
  }

  // 3c-1: compiled wiki excerpts give curated/synthesized context that
  // complements raw recall. Pages exist when the user has run compile_wiki;
  // section is omitted when no hits return.
  const wikiText = formatWikiContext(wikiContext, 5);
  if (wikiText) {
    sections.push(`## Wiki excerpts\n${wikiText}\n_Use \`get_page\` MCP tool to read full content._`);
  }

  const recallText = formatRecall(recall, caps.frames);
  if (recallText) {
    sections.push(`## Relevant memory\n${recallText}`);
  }

  // 3e-2: cross-project hits placed AFTER the regular recall so the
  // current-workspace context comes first, then "by the way" notes from
  // other projects. Lower visual priority is intentional — these are
  // hints, not commands.
  const crossProjectText = formatCrossProjectHits(crossProjectHits);
  if (crossProjectText) {
    sections.push(
      `## By the way — related work in other projects\n` +
        `_Earlier work in another workspace looks semantically related._\n` +
        `${crossProjectText}`
    );
  }

  return sections.join('\n\n');
}

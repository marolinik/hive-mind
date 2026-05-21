#!/usr/bin/env node
/**
 * UserPromptSubmit hook (sandbox).
 *
 * The upstream hook is WRITE-ONLY (saves the prompt as a frame).
 * This sandbox version does BOTH:
 *   (a) save the prompt as a temporary frame (workspace-aware)
 *   (b) recall N relevant frames using a query built from prompt+project
 *       and emit them as additionalContext for in-loop enrichment.
 *
 * Hard budget: 4000ms. Fail-open.
 */
import { readStdinJson, emitStdout, runHookBody } from './_shared.js';
import {
  deriveWorkspace,
  buildRecallQuery,
  composeContext,
  callMcp,
  getTier,
  detectFailureMatches,
  failureFrameIds,
  splitCrossProjectHits,
  findDecisionMatches,
  findContradictions,
  dropBookkeeping,
  semanticFilter,
} from '@hive-mind/enrichment';

await runHookBody('user-prompt-submit', 4000, async () => {
  const payload = await readStdinJson();
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : 'unknown';

  const ws = deriveWorkspace(cwd);
  const tier = getTier();
  const recallLimit = Math.min(5, tier.frames);

  const query = buildRecallQuery({ cwd, prompt });

  const savePromise = prompt
    ? callMcp(
        'save_memory',
        {
          content: `[hm session:${sessionId} src:claude-code event:user-prompt-submit ws:${ws.id}] ${prompt}`,
          importance: 'temporary',
          source: 'user_stated',
          workspace: ws.id,
        },
        { timeoutMs: 2000 }
      )
    : Promise.resolve({ ok: true });

  // scope:"all" = personal + active workspace (when one is derived from CWD).
  // Falls back to personal-only behavior when no workspaces exist.
  const recallPromise = callMcp(
    'recall_memory',
    { query, limit: recallLimit, scope: 'all', workspace: ws.id, profile: 'important' },
    { timeoutMs: 3000 }
  );

  // 3c-2 (2026-05-07): also pull top wiki pages for the prompt. Workspace-scoped
  // when CWD maps to a registered workspace; falls back to personal otherwise.
  // Wiki gives entity-level summaries that complement the raw frames recall
  // returns. Soft fail — empty array if MCP errors or no pages compiled yet.
  //
  // Use the RAW prompt for the wiki search rather than the project-augmented
  // `query` from buildRecallQuery: search_wiki does substring match on page
  // name/slug, so prepending the project name (e.g. "hive-mind reranker")
  // would prevent matches against single-name pages ("reranker"). The prompt
  // alone gives the best chance of hitting an entity page directly.
  //
  // Two-stage strategy: try the active workspace wiki first (most relevant),
  // then personal wiki for anything the workspace didn't have. The user's
  // prompt may reference an entity that lives in a different workspace's
  // wiki (e.g. "reranker" lives in proj-hive-mind, but the user is in
  // proj-projects); personal wiki acts as the cross-workspace fallback when
  // it has been compiled with --all-workspaces or covers shared concepts.
  const wikiQuery = prompt && prompt.length <= 200 ? prompt : query;
  const inWorkspace = ws.id && ws.id !== 'personal';
  const wikiPromise = inWorkspace
    ? callMcp('search_wiki', { query: wikiQuery, limit: 5, workspace_id: ws.id }, { timeoutMs: 2000 })
    : callMcp('search_wiki', { query: wikiQuery, limit: 5 }, { timeoutMs: 2000 });

  const [, recallRes, wikiRes] = await Promise.all([savePromise, recallPromise, wikiPromise]);
  const rawRecall = recallRes.ok ? recallRes.data : [];

  // 2026-05-08: filter bookkeeping frames once, here, before any downstream
  // consumer (regular recall section, 3e-1 failure, 3e-2 cross-project, 3e-4
  // contradiction) sees them. Three classes of bookkeeping noise:
  //   - wiki-synth session-summaries (third-person meta, never user-stated)
  //   - own user-prompt-submit traces (raw prompt echoes from this hook)
  //   - own post-tool-use traces (tool-call bookkeeping)
  // Unified filter per Marko's 2026-05-08 decision: continuity comes from
  // wiki-synth's curated summaries + last-activity greeting + harvested
  // .mind/ content, not from raw bookkeeping frames.
  const recall = dropBookkeeping(rawRecall);
  // search_wiki returns either the wrapped envelope (handled by callMcp) OR
  // a "No wiki pages matching X" string when the wiki is empty. Defend against
  // the string shape so composeContext gets an array, not a string.
  let wikiContext = wikiRes.ok && Array.isArray(wikiRes.data) ? wikiRes.data : [];
  // Fallback: workspace wiki had no hits, try personal wiki. Sequential rather
  // than parallel because we only want this when the primary returned empty —
  // saves the extra MCP call on every prompt that already had workspace hits.
  if (inWorkspace && wikiContext.length === 0) {
    const fallback = await callMcp('search_wiki', { query: wikiQuery, limit: 5 }, { timeoutMs: 2000 });
    if (fallback.ok && Array.isArray(fallback.data)) {
      wikiContext = fallback.data;
    }
  }

  // 3e-1: scan recall for past-failure semantic matches BEFORE rendering.
  // Detection is regex-on-content over the already-relevance-ranked recall;
  // no extra MCP call. Top-2 matches surface as a "Heads-up" callout. Frames
  // that match are filtered OUT of the regular recall section so the same
  // entry doesn't appear twice.
  // B5 (2026-05-08): when HIVE_MIND_VERIFY_LLM=1, run candidates through
  // ollama-cosine semantic filter — drops type-C noise (broad-keyword
  // overlap that's topically off). Fail-open if ollama unreachable.
  const failureCandidates = detectFailureMatches(recall, { maxMatches: 2 });
  const failurePatterns = await semanticFilter(prompt, failureCandidates, (m) =>
    String(m.frame.content || '')
  );
  const matchedIds = failureFrameIds(failurePatterns);
  const recallForFiltering =
    matchedIds.size > 0
      ? recall.filter((h) => !(typeof h.id === 'number' && matchedIds.has(h.id)))
      : recall;

  // 3e-2: split remaining recall into in-project vs cross-project. The
  // existing scope: 'all' MCP query already pulls from every workspace;
  // splitting here gives cross-project hits their own callout instead of
  // letting them bury more-relevant in-project hits in a single sorted list.
  const { inProject, crossProject } = splitCrossProjectHits(
    recallForFiltering,
    ws.id,
    { maxCrossProject: 2 }
  );

  // 3e-3: decision archaeology. Cheap on disk: only fires when prompt is
  // a "why" question; reads from auto-memory feedback files, not the mind.
  // Returns [] silently if no overlap — never throws into the hook body.
  const decisionMatches = findDecisionMatches({ prompt, cwd, maxMatches: 2 });

  // 3e-4: contradiction detection. Default-on per 2026-05-06 decision;
  // disable globally with HIVE_MIND_CONTRADICTION_OFF=1. Heuristic regex
  // matcher; soft warning, never blocks. Skipped when prompt itself uses
  // negation (the user is likely asking ABOUT the rule, not violating it).
  // B5: same semantic-verification pass as 3e-1. Compares prompt against
  // each rule snippet; drops candidates below the cosine threshold.
  const contradictionCandidates = findContradictions({ prompt, cwd, maxMatches: 2 });
  const contradictions = await semanticFilter(prompt, contradictionCandidates, (c) =>
    String(c.rule || '')
  );

  const additionalContext = composeContext({
    project: { id: ws.id, name: ws.name },
    recall: inProject,
    wikiContext,
    failurePatterns,
    crossProjectHits: crossProject,
    decisionMatches,
    contradictions,
  });

  emitStdout({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: additionalContext || '',
    },
  });
});

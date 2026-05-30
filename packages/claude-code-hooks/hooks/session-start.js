#!/usr/bin/env node
/**
 * SessionStart hook.
 *
 *   - derives workspace from cwd
 *   - builds a query-aware recall (project name + recent topics)
 *   - additionally pulls identity + awareness + workspace-scoped "last activity"
 *   - composes a 4-layer additionalContext block
 *   - opportunistically kicks the synth-drain catch-up when the queue has work
 *   - never blocks beyond a hard 4s budget
 */
import { spawn as childSpawn } from 'node:child_process';
import { existsSync, openSync, closeSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readStdinJson, emitStdout, runHookBody } from './_shared.js';
import {
  deriveWorkspace,
  buildRecallQuery,
  composeContext,
  callMcp,
  getTier,
  listPending,
  isDrainLocked,
} from '@hive-mind/enrichment';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Synth-drain log dir lives in the user's home, never the plugin dir
// (the plugin dir may be read-only or relocated).
const DRAIN_LOG_DIR = join(homedir(), '.hive-mind', 'logs', 'synth-drain');

// Resolve the drain script via:
//   1. HIVE_MIND_DRAIN_SCRIPT env override
//   2. Plugin-local lookup: walk up from this hook to find packages/enrichment/bin/synth-drain.js
//   3. npm package resolution (works when @hive-mind/enrichment is installed)
//   4. null — disables catch-up (graceful, optional feature)
function resolveDrainScript() {
  if (process.env.HIVE_MIND_DRAIN_SCRIPT && existsSync(process.env.HIVE_MIND_DRAIN_SCRIPT)) {
    return process.env.HIVE_MIND_DRAIN_SCRIPT;
  }
  // Walk up looking for packages/enrichment/bin/synth-drain.js
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = resolvePath(dir, 'enrichment', 'bin', 'synth-drain.js');
    if (existsSync(candidate)) return candidate;
    const candidate2 = resolvePath(dir, '..', 'enrichment', 'bin', 'synth-drain.js');
    if (existsSync(candidate2)) return candidate2;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('@hive-mind/enrichment/bin/synth-drain.js');
  } catch { return null; }
}

const DRAIN_SCRIPT = resolveDrainScript();
const CATCH_UP_QUEUE_THRESHOLD = 1; // any pending tasks are enough
const CATCH_UP_STALE_MINUTES = 30;  // skip if any drain ran in the last 30 min

/**
 * Returns the most-recent mtime (ms epoch) of any synth-drain log file,
 * or 0 if none exist. Cheap directory scan, capped at the few latest entries.
 */
function lastDrainLogMtimeMs() {
  try {
    if (!existsSync(DRAIN_LOG_DIR)) return 0;
    const files = readdirSync(DRAIN_LOG_DIR).filter((f) => f.startsWith('synth-drain-') && f.endsWith('.log'));
    if (files.length === 0) return 0;
    let max = 0;
    for (const f of files) {
      try {
        const st = statSync(join(DRAIN_LOG_DIR, f));
        if (st.mtimeMs > max) max = st.mtimeMs;
      } catch {
        // skip files we can't stat
      }
    }
    return max;
  } catch {
    return 0;
  }
}

/**
 * Fire-and-forget background drain when the queue has pending work and no
 * drain has run recently. Survives parent exit via detached + unref.
 *
 * Returns a short status string for telemetry, or '' if no kick happened.
 */
function maybeKickCatchUpDrain() {
  // If we couldn't locate the drain script (no plugin layout, no npm install,
  // no env override), the catch-up feature is silently disabled.
  if (!DRAIN_SCRIPT) return '';

  let pendingCount;
  try {
    pendingCount = listPending(50).length;
  } catch {
    return '';
  }
  if (pendingCount < CATCH_UP_QUEUE_THRESHOLD) return '';

  // Skip if another drain is already running. Cheap stat check.
  if (isDrainLocked()) return 'catch-up skipped (drain already running)';

  const lastMs = lastDrainLogMtimeMs();
  const ageMin = lastMs === 0 ? Infinity : (Date.now() - lastMs) / 60000;
  if (ageMin < CATCH_UP_STALE_MINUTES) return '';

  try {
    if (!existsSync(DRAIN_LOG_DIR)) mkdirSync(DRAIN_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(DRAIN_LOG_DIR, `synth-drain-catch-up-${ts}.log`);
    const fd = openSync(logPath, 'a');
    const proc = childSpawn(
      process.execPath, // node binary
      [DRAIN_SCRIPT, '--use-cc', '--all', '--max=10', '--limit=8'],
      {
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      }
    );
    proc.unref();
    closeSync(fd);
    return `catch-up drain kicked (queue=${pendingCount}, last_drain_age_min=${Math.round(ageMin)})`;
  } catch (err) {
    return `catch-up drain failed: ${err && err.message ? err.message : String(err)}`;
  }
}

await runHookBody('session-start', 4000, async () => {
  const payload = await readStdinJson();
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();
  const ws = deriveWorkspace(cwd);
  const tier = getTier();

  // Phase 3a-4: opportunistic drain catch-up. Fire-and-forget so we don't
  // eat the hook's 4s budget. Subprocesses spawned by the drain set
  // HIVE_MIND_NO_SYNTH=1, so this can't trigger the feedback loop fixed
  // in Phase 2. Race risk with daily 04:00 task is bounded by the
  // CATCH_UP_STALE_MINUTES gate; full lock-based safety lands in 3a-5.
  const catchUpStatus = maybeKickCatchUpDrain();
  if (catchUpStatus) {
    process.stderr.write(`[session-start] ${catchUpStatus}\n`);
  }

  const query = buildRecallQuery({ cwd, prompt: '', recentTopics: [] });

  // Workspace-scoped query for the "Last activity" greeting section.
  // Empty-ish query + workspace scope returns recent frames in this project,
  // which the composer then dedups + sorts recency-desc.
  const lastActivityQuery = ws.id || ws.name || '';

  // Build a wiki-search query from the workspace name. Workspace IDs like
  // `proj-hive-mind` map to wiki pages by entity (hive-mind concepts) rather
  // than literal ID — we strip the `proj-` prefix and split on hyphens to
  // produce a query the wiki's name-search can match.
  const wikiQuery = ((ws.name || ws.id || '').replace(/^proj-/i, '') || '').replace(/-+/g, ' ').trim();

  const [recallRes, identityRes, awarenessRes, lastActivityRes, wikiRes] = await Promise.all([
    callMcp('recall_memory', { query, limit: tier.frames, scope: 'personal', profile: 'important' }, { timeoutMs: 3000 }),
    callMcp('get_identity', {}, { timeoutMs: 1500 }),
    callMcp('get_awareness', {}, { timeoutMs: 1500 }),
    ws.id
      ? callMcp(
          'recall_memory',
          // scope:'current' + workspace restricts to a single workspace mind.
          // scope:'all' silently dropped the workspace arg and bled frames
          // from every workspace into the "Last activity" greeting.
          // profile:'recent' matches the "what was I doing" intent better
          // than 'important' (which favors high-importance frames anywhere).
          { query: lastActivityQuery, limit: 8, scope: 'current', workspace: ws.id, profile: 'recent' },
          { timeoutMs: 3000 }
        )
      : Promise.resolve({ ok: true, data: [] }),
    wikiQuery
      ? callMcp('search_wiki', { query: wikiQuery, limit: 5 }, { timeoutMs: 2000 })
      : Promise.resolve({ ok: true, data: [] }),
  ]);

  const recall = recallRes.ok ? recallRes.data : [];
  const identity = identityRes.ok ? identityRes.data : null;
  const awareness = awarenessRes.ok ? awarenessRes.data : null;
  const lastActivityRaw = lastActivityRes.ok ? lastActivityRes.data : [];
  const wikiContext = wikiRes.ok ? wikiRes.data : [];

  // Sort recency-desc so the composer renders newest first.
  const lastActivity = Array.isArray(lastActivityRaw)
    ? [...lastActivityRaw].sort((a, b) => {
        const ta = Date.parse(a.created_at || a.createdAt || 0) || 0;
        const tb = Date.parse(b.created_at || b.createdAt || 0) || 0;
        return tb - ta;
      })
    : [];

  const additionalContext = composeContext({
    project: { id: ws.id, name: ws.name },
    recall,
    identity,
    awareness,
    lastActivity,
    wikiContext,
  });

  emitStdout({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: additionalContext || '',
    },
  });
});

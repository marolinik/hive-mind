#!/usr/bin/env node
/**
 * Live smoke of the 5 Claude Code lifecycle hooks.
 *
 * The bug fixed this session (the duplicate-export crash) was an IMPORT-time
 * failure: every hook died before running. These checks run each hook as Claude
 * Code does — a JSON event on stdin, hook env set — and assert it loads its full
 * `@hive-mind/enrichment` module graph (the thing that crashed) and exits 0.
 *
 * Two modes, chosen for SAFETY (the synth queue + cognify marker live in the
 * real ~/.hive-mind, not the fixture):
 *   - FULL BODY  (session-start, user-prompt-submit, pre-compact): writes land in
 *     the fixture, so we run the real body and assert its output/side-effects.
 *     session-start's drain-kick is neutralized via HIVE_MIND_DRAIN_SCRIPT=no-op.
 *   - LOAD+GUARD (stop, post-tool-use): their body would append to the global
 *     synth queue / write the global cognify marker, so we run with
 *     HIVE_MIND_NO_SYNTH=1 — the module graph still fully loads (proving the
 *     regression is gone), then the guard exits 0 without touching real state.
 *
 * Usage:  npm run e2e:hooks   (or: node e2e/hooks-verify.mjs). Requires npm run build.
 * Exit 0 = all hooks loaded + ran to exit 0 (and the full-body ones produced output).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed, fixtureEnv } from './seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'packages', 'cli', 'dist', 'index.js');
const HOOKS = path.join(REPO, 'packages', 'claude-code-hooks', 'hooks');
const DATA_DIR = path.join(REPO, '.e2e-tmp', 'mind-hooks');
const NOOP_DRAIN = path.join(__dirname, '_noop-drain.mjs');

function runHook(file, { stdin, fullBody, extraEnv = {}, timeout = 30_000 }) {
  const env = { ...fixtureEnv(DATA_DIR), HIVE_MIND_DRAIN_SCRIPT: NOOP_DRAIN, ...extraEnv };
  // fixtureEnv sets HIVE_MIND_NO_SYNTH=1. Full-body hooks must run their body,
  // so drop it; load+guard hooks keep it.
  if (fullBody) delete env.HIVE_MIND_NO_SYNTH;
  const res = spawnSync(process.execPath, [path.join(HOOKS, file)], {
    env, input: JSON.stringify(stdin), encoding: 'utf8', timeout,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    timedOut: res.error?.code === 'ETIMEDOUT',
  };
}

/** Recall against the fixture to confirm a hook's write actually landed. */
function fixtureRecall(query) {
  const res = spawnSync(
    process.execPath,
    [CLI, 'mcp', 'call', 'recall_memory', '--args', JSON.stringify({ query, scope: 'all', limit: 20 }), '--json'],
    { env: fixtureEnv(DATA_DIR), encoding: 'utf8', timeout: 30_000 },
  );
  try {
    const parsed = JSON.parse(res.stdout);
    const text = parsed?.content?.[0]?.text;
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

const checks = [
  {
    name: 'session-start (full body emits context)',
    run: () => {
      const r = runHook('session-start.js', { fullBody: true, stdin: { hook_event_name: 'SessionStart', cwd: REPO, session_id: 'e2e-smoke' } });
      const okEmit = /SessionStart/.test(r.stdout) && /additionalContext/.test(r.stdout);
      return { ok: r.status === 0 && okEmit, detail: `status=${r.status} emitted=${okEmit}${r.timedOut ? ' TIMEOUT' : ''}` };
    },
  },
  {
    name: 'user-prompt-submit (full body emits context)',
    run: () => {
      const r = runHook('user-prompt-submit.js', { fullBody: true, extraEnv: { HIVE_MIND_CONTRADICTION_OFF: '1' }, stdin: { prompt: 'ZephyrFixture hybrid search SQLite', cwd: REPO, session_id: 'e2e-smoke' } });
      const okEmit = /UserPromptSubmit/.test(r.stdout);
      return { ok: r.status === 0 && okEmit, detail: `status=${r.status} emitted=${okEmit}${r.timedOut ? ' TIMEOUT' : ''}` };
    },
  },
  {
    name: 'user-prompt-submit persisted a frame (functional)',
    run: () => {
      const hits = fixtureRecall('user-prompt-submit ZephyrFixture');
      const found = hits.some((f) => String(f.content).includes('event:user-prompt-submit'));
      return { ok: found, detail: found ? 'prompt frame found in fixture' : `${hits.length} hits, no prompt frame` };
    },
  },
  {
    name: 'pre-compact (full body, writes to fixture)',
    run: () => {
      const r = runHook('pre-compact.js', { fullBody: true, stdin: { cwd: REPO, session_id: 'e2e-smoke', summary: 'E2E pre-compact summary mentioning ZephyrFixture.' } });
      return { ok: r.status === 0, detail: `status=${r.status}${r.timedOut ? ' TIMEOUT' : ''}` };
    },
  },
  {
    name: 'stop (load+guard, no global write)',
    run: () => {
      const r = runHook('stop.js', { fullBody: false, stdin: { cwd: REPO, session_id: 'e2e-smoke' } });
      return { ok: r.status === 0, detail: `status=${r.status}${r.timedOut ? ' TIMEOUT' : ''}` };
    },
  },
  {
    name: 'post-tool-use (load+guard, no cognify spawn)',
    run: () => {
      const r = runHook('post-tool-use.js', { fullBody: false, stdin: { tool_name: 'Bash', tool_input: {}, tool_response: {} } });
      return { ok: r.status === 0, detail: `status=${r.status}${r.timedOut ? ' TIMEOUT' : ''}` };
    },
  },
];

function main() {
  process.stdout.write(`[e2e:hooks] seeding fixture -> ${DATA_DIR}\n`);
  seed(DATA_DIR);
  process.stdout.write('[e2e:hooks] smoking 5 lifecycle hooks\n');

  let failed = 0;
  for (const c of checks) {
    let res;
    try { res = c.run(); } catch (err) { res = { ok: false, detail: `threw: ${err.message}` }; }
    if (!res.ok) failed++;
    process.stdout.write(`  [${res.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(48)} ${res.detail}\n`);
  }
  process.stdout.write(`[e2e:hooks] ${checks.length - failed}/${checks.length} checks passed\n`);
  return failed === 0 ? 0 : 1;
}

process.exit(main());

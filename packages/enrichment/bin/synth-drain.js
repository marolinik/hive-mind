#!/usr/bin/env node
/**
 * Drain one pending entry from the synth queue.
 *
 * Modes (mutually exclusive):
 *   default      print prompt to stdout, claim task as in_flight
 *                (caller pipes stdout to `claude -p` or pastes into CC)
 *   --dry-run    print prompt but DO NOT claim or modify the queue
 *   --use-cc     spawn `claude -p` subprocess, pipe prompt as stdin, capture
 *                stdout as synthesis, save as frame, mark task done
 *                (CC-as-synthesizer path — zero API key required)
 *   --use-api    POST prompt to Anthropic Messages API (requires
 *                ANTHROPIC_API_KEY env), save synthesis frame, mark task done
 *
 * Flags:
 *   --limit=N              max source frames to fetch (default 50)
 *   --model=M              Anthropic model id (default claude-sonnet-4-6, used by --use-api)
 *   --time-budget-min=N    abort --all loop after N minutes wall-clock (default 10)
 *                          guards against runaway drains chewing through CC quota
 */
import { spawn } from 'node:child_process';
import { callMcp } from '../src/cli-bridge.js';
import {
  nextPending,
  listPending,
  markInFlight,
  markDone,
  acquireDrainLock,
  releaseDrainLock,
} from '../src/synth-queue.js';
import { buildSynthPrompt } from '../src/synth-prompt.js';

function parseFlags(argv) {
  const f = {
    dryRun: false, useApi: false, useCc: false, all: false,
    max: 0, limit: 50, model: 'claude-sonnet-4-6',
    timeBudgetMin: 10, // wall-clock cap for --all loop
  };
  for (const a of argv) {
    if (a === '--dry-run') f.dryRun = true;
    else if (a === '--use-api') f.useApi = true;
    else if (a === '--use-cc') f.useCc = true;
    else if (a === '--all') f.all = true;
    else if (a.startsWith('--max=')) f.max = Number(a.split('=')[1]) || 0;
    else if (a.startsWith('--limit=')) f.limit = Number(a.split('=')[1]) || 50;
    else if (a.startsWith('--model=')) f.model = a.split('=')[1];
    else if (a.startsWith('--time-budget-min=')) {
      const n = Number(a.split('=')[1]);
      f.timeBudgetMin = Number.isFinite(n) && n >= 0 ? n : 10;
    }
  }
  return f;
}

function callCcPrint(prompt) {
  return new Promise((resolve, reject) => {
    // 2026-05-08: claude is a real .exe (not a .cmd batch) on this machine,
    // so we can spawn it directly. shell:true wraps the call in cmd.exe and
    // on Win11 with Windows Terminal as default console host, WT surfaces a
    // tab for the wrapper even with windowsHide. Skipping the shell wrapper
    // makes windowsHide actually hide the process. CLAUDE_BIN env override
    // lets ops point at a different binary if claude is installed elsewhere.
    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    const proc = spawn(claudeBin, ['-p', '--output-format=text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // HIVE_MIND_NO_SYNTH=1 makes hive-mind hooks no-op inside this subprocess
      // so its Stop event doesn't enqueue a successor synth task (feedback loop).
      env: { ...process.env, HIVE_MIND_NO_SYNTH: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => reject(new Error(`spawn claude failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 400)}`));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function fetchFrames(query, limit) {
  if (!query) return [];
  const r = await callMcp(
    'recall_memory',
    { query, limit, scope: 'all', profile: 'recent' },
    { timeoutMs: 4000 }
  );
  return r.ok && Array.isArray(r.data) ? r.data : [];
}

async function callAnthropic(prompt, model) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set — run without --use-api or set the env var');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  return text;
}

async function processOne(task, flags) {
  const frames = await fetchFrames(task.context_query || task.subject, flags.limit);
  const prompt = buildSynthPrompt({ task, frames });

  if (flags.dryRun) {
    process.stderr.write(`# DRY RUN — task ${task.id} not claimed (${frames.length} frames)\n`);
    process.stdout.write(prompt);
    return { ok: true };
  }

  markInFlight(task.id);

  if (!flags.useApi && !flags.useCc) {
    process.stderr.write(`# task ${task.id} claimed (${frames.length} frames). Pipe stdout into CC, then run: synth-queue done ${task.id} [--frame=N]\n`);
    process.stdout.write(prompt);
    return { ok: true };
  }

  const synthText = flags.useCc
    ? await callCcPrint(prompt)
    : await callAnthropic(prompt, flags.model);

  // Defense in depth: treat the literal string 'personal' as a sentinel
  // for "use personal mind", not as a workspace ID. Otherwise auto-attach
  // would create a rogue workspace called "personal".
  const wsArg = task.ws_id && task.ws_id !== 'personal' ? task.ws_id : undefined;
  const saveRes = await callMcp(
    'save_memory',
    {
      content: `[wiki-synth task:${task.id} kind:${task.kind} ws:${wsArg || 'personal'}]\n${synthText}`,
      importance: 'important',
      source: 'agent_inferred',
      workspace: wsArg,
    },
    { timeoutMs: 4000 }
  );
  const frameId = saveRes.ok && saveRes.data && saveRes.data.id ? saveRes.data.id : null;
  markDone(task.id, { frame_id: frameId });
  process.stderr.write(`# done — task ${task.id} synthesized via ${flags.useCc ? 'cc' : 'api'} → frame ${frameId}\n`);
  return { ok: true, frameId };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  // Drain-all loop: process every pending task in a single invocation.
  // Snapshots the pending list upfront so --dry-run doesn't loop forever
  // on the same un-claimed task. Errors stop the loop so a single bad
  // task doesn't burn through all pending work silently.
  if (flags.all) {
    // 3a-5: serialize via filesystem lock. Concurrent drains (e.g., daily
    // Task Scheduler firing while a SessionStart catch-up is mid-run) would
    // race on synth-queue.jsonl. Stale locks (>10min) are auto-reclaimed.
    if (!flags.dryRun && !acquireDrainLock()) {
      process.stderr.write('# another drain is already holding the lock — exiting clean\n');
      return;
    }
    // Best-effort lock release on signals so a Ctrl+C doesn't leak the lock
    // for the full LOCK_STALE_MS window.
    const releaseAndExit = (code) => {
      try { releaseDrainLock(); } catch { /* noop */ }
      process.exit(code);
    };
    process.on('SIGINT', () => releaseAndExit(130));
    process.on('SIGTERM', () => releaseAndExit(143));

    try {
      const tasks = listPending(200);
      const cap = flags.max > 0 ? Math.min(flags.max, tasks.length) : tasks.length;
      const budgetMs = flags.timeBudgetMin > 0 ? flags.timeBudgetMin * 60_000 : 0;
      const start = Date.now();
      let processed = 0;
      let abortedByBudget = false;
      for (let i = 0; i < cap; i++) {
        // Check wall-clock budget before each task. Aborting before claiming
        // (rather than mid-task) leaves the queue in a clean state — no orphan
        // in_flight entries to reclaim.
        if (budgetMs > 0 && Date.now() - start >= budgetMs) {
          abortedByBudget = true;
          break;
        }
        const task = tasks[i];
        try {
          await processOne(task, flags);
          processed++;
        } catch (err) {
          process.stderr.write(`# stopping --all loop after error: ${err.message}\n`);
          process.exit(2);
        }
      }
      if (abortedByBudget) {
        const elapsedMin = Math.round((Date.now() - start) / 60_000);
        process.stderr.write(`# drain --all aborted by --time-budget-min=${flags.timeBudgetMin} after ${elapsedMin}min. processed=${processed}/${tasks.length}\n`);
      } else {
        process.stderr.write(`# drain --all complete. processed=${processed}/${tasks.length}\n`);
      }
      return;
    } finally {
      releaseDrainLock();
    }
  }

  const task = nextPending();
  if (!task) {
    process.stdout.write('# no pending synth tasks\n');
    return;
  }
  await processOne(task, flags);
}

main().catch((err) => {
  process.stderr.write(`# synth-drain failed: ${err.message}\n`);
  process.exit(2);
});

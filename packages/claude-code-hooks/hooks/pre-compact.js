#!/usr/bin/env node
/**
 * PreCompact hook (sandbox). Calls hive-mind-cli's `save-session` subcommand
 * with the conversation summary. Falls back to save_memory.
 * Budget: 4000ms.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readStdinJson, runHookBody } from './_shared.js';
import { deriveWorkspace, callMcp, getCliPath } from '@hive-mind/enrichment';

function spawnSaveSession(cliPath, summaryFile, timeoutMs) {
  return new Promise((resolve) => {
    if (!existsSync(cliPath)) return resolve({ ok: false, error: 'cli missing' });
    const child = spawn(
      process.execPath,
      [cliPath, 'save-session', '--file', summaryFile, '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    let settled = false;
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `exit ${code}: ${stderr.slice(0, 200)}` });
    });
  });
}

await runHookBody('pre-compact', 4000, async () => {
  const payload = await readStdinJson();
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : 'unknown';
  const summary = typeof payload.summary === 'string' ? payload.summary : '';
  const ws = deriveWorkspace(cwd);

  // Try save-session first
  if (summary) {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hm-presend-'));
    const tmpFile = path.join(tmpDir, 'summary.txt');
    try {
      writeFileSync(tmpFile, summary, 'utf8');
      const res = await spawnSaveSession(getCliPath(), tmpFile, 3000);
      if (res.ok) return;
    } catch { /* fall through to save_memory */ }
  }

  // Fallback: save_memory
  const content = summary
    ? `[hm session:${sessionId} src:claude-code event:pre-compact ws:${ws.id}] ${summary}`
    : `[hm session:${sessionId} src:claude-code event:pre-compact ws:${ws.id}] (no summary)`;
  await callMcp(
    'save_memory',
    {
      content,
      importance: 'normal',
      source: 'system',
      workspace: ws.id,
    },
    { timeoutMs: 2000 }
  );
});

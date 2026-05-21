#!/usr/bin/env node
/**
 * Stop hook (sandbox).
 *   (a) saves a session-end summary frame
 *   (b) enqueues a synthesis task for the session (consumed by SessionStart
 *       hook or standalone drain script — see packages/enrichment/synth-queue.js)
 *
 * Fail-open. Budget: 2000ms.
 */
import { readStdinJson, runHookBody } from './_shared.js';
import {
  deriveWorkspace,
  callMcp,
  enqueueSynth,
  listPending,
} from '@hive-mind/enrichment';

await runHookBody('stop', 2000, async () => {
  const payload = await readStdinJson();
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : 'unknown';
  const ws = deriveWorkspace(cwd);

  const content = `[hm session:${sessionId} src:claude-code event:stop ws:${ws.id}] session ended at ${new Date().toISOString()}`;
  await callMcp(
    'save_memory',
    {
      content,
      importance: 'temporary',
      source: 'system',
      workspace: ws.id,
    },
    { timeoutMs: 1500 }
  );

  // Enqueue a synthesis task for this session — but dedup by session_id.
  // CC fires Stop on every turn-end, not just session close, so without dedup
  // a single conversation produces N pending tasks all describing the same
  // session frames. enqueueSynth never throws — the Stop event must not be
  // blocked by queue-file errors.
  if (sessionId && sessionId !== 'unknown') {
    const existing = listPending(200).find(
      (e) => e.session_id === sessionId && e.kind === 'session-summary',
    );
    if (!existing) {
      enqueueSynth({
        kind: 'session-summary',
        subject: `session ${sessionId}`,
        context_query: `hm session:${sessionId}`,
        ws_id: ws.id,
        session_id: sessionId,
      });
    }
  }
});

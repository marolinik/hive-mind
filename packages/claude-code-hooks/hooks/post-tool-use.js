#!/usr/bin/env node
/**
 * PostToolUse hook (sandbox).
 * Fire-and-forget: trigger cognify if recent frames exceed threshold AND
 * we haven't cognified in the last THROTTLE_MS window. Adds ~0ms to hook
 * latency.
 *
 * 2026-05-07: throttle bumped to 5min and HIVE_MIND_NO_SYNTH guard added.
 *   - Throttle: cognify now runs LLM extraction (~30s/batch). 60s windows
 *     could overlap on busy turns; 5min keeps cost bounded while still
 *     catching new frames within the same session.
 *   - HIVE_MIND_NO_SYNTH=1 skip: when the upstream cognify command spawns
 *     `claude -p` subprocesses for LLM extraction, those nested CC instances
 *     also fire post-tool-use hooks. Without this guard, a nested CC's tool
 *     call would re-trigger cognify and recurse. The synth-drain pipeline
 *     established the same env-var convention in 2026-05-06.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { triggerCognify } from '@hive-mind/enrichment';

const THROTTLE_MS = 300_000;
const MARKER = path.join(os.homedir(), '.hive-mind', '.last-cognify');

function readLast() {
  try {
    if (!existsSync(MARKER)) return 0;
    const raw = readFileSync(MARKER, 'utf8').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function writeLast(ts) {
  try { writeFileSync(MARKER, String(ts), 'utf8'); } catch { /* noop */ }
}

(function main() {
  // Skip when running inside a nested claude -p (e.g. cognify's LLM
  // extractor). The env var is propagated by every spawn site that wants
  // its child CC to be hook-quiet.
  if (process.env.HIVE_MIND_NO_SYNTH === '1') {
    process.exit(0);
    return;
  }

  // Don't even read stdin — we don't need it. Just check throttle and emit.
  const now = Date.now();
  const last = readLast();
  if (now - last < THROTTLE_MS) {
    process.exit(0);
    return;
  }
  writeLast(now);
  triggerCognify();
  process.exit(0);
})();

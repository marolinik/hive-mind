/**
 * Synthesis-task queue (Phase 1).
 *
 * Stores pending wiki-synthesis tasks as a JSON-Lines file at
 * ~/.hive-mind/synth-queue.jsonl. Append-only writes (cheap, atomic enough
 * for Stop-hook contention); compaction on markDone via tmp+rename.
 *
 * Two consumers (phase 2):
 *   - SessionStart hook: drains 1 pending entry, composes it as
 *     additionalContext for in-conversation synthesis (CC-as-synthesizer).
 *   - Standalone drain script: reads queue, calls Anthropic API directly
 *     when ANTHROPIC_API_KEY is set (OSS upstream path).
 *
 * Producers (phase 1):
 *   - Stop hook: enqueues one session-summary task per session.
 *   - (later) wiki-web on-read: marks a page dirty when its underlying
 *     frames have new mtime since last synth.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const QUEUE_DIR = path.join(os.homedir(), '.hive-mind');
const QUEUE_FILE = path.join(QUEUE_DIR, 'synth-queue.jsonl');

function ensureQueueDir() {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

function readAll() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupt lines — fail-open
    }
  }
  return out;
}

function writeAll(entries) {
  ensureQueueDir();
  const tmp = QUEUE_FILE + '.tmp';
  const body = entries.length === 0
    ? ''
    : entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, QUEUE_FILE);
}

/**
 * Append a new task to the queue. Returns the created entry.
 * Never throws on disk error — Stop-hook contract requires fail-open.
 */
export function enqueueSynth(task) {
  try {
    ensureQueueDir();
    const entry = {
      id: `synth-${crypto.randomUUID()}`,
      kind: task.kind || 'session-summary',
      subject: typeof task.subject === 'string' ? task.subject : '',
      context_query: typeof task.context_query === 'string' ? task.context_query : '',
      ws_id: task.ws_id || null,
      session_id: task.session_id || null,
      enqueued_at: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
    };
    fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  } catch {
    return null;
  }
}

export function listPending(limit = 50) {
  return readAll().filter((e) => e.status === 'pending').slice(0, limit);
}

export function listAll(limit = 200) {
  return readAll().slice(-limit);
}

export function nextPending() {
  return listPending(1)[0] || null;
}

/**
 * Atomically mark an entry as in_flight (consumer claims it).
 * Returns the updated entry, or null if not found / not pending.
 */
export function markInFlight(id) {
  const all = readAll();
  let updated = null;
  for (const e of all) {
    if (e.id === id && e.status === 'pending') {
      e.status = 'in_flight';
      e.attempts = (e.attempts || 0) + 1;
      e.started_at = new Date().toISOString();
      updated = e;
      break;
    }
  }
  if (updated) writeAll(all);
  return updated;
}

/**
 * Mark an entry as done. Optional result metadata (e.g. {frame_id, page_slug}).
 */
export function markDone(id, result = {}) {
  const all = readAll();
  let changed = false;
  for (const e of all) {
    if (e.id === id) {
      e.status = 'done';
      e.completed_at = new Date().toISOString();
      if (result.frame_id) e.result_frame_id = result.frame_id;
      if (result.page_slug) e.result_page_slug = result.page_slug;
      changed = true;
      break;
    }
  }
  if (changed) writeAll(all);
  return changed;
}

/**
 * Reset in_flight entries older than `olderThanMs` back to pending.
 * Use to recover from stuck/abandoned synthesizer runs.
 * Returns the count of reclaimed entries.
 */
export function reclaimInFlight(olderThanMs = 30 * 60 * 1000) {
  const all = readAll();
  const cutoff = Date.now() - olderThanMs;
  let count = 0;
  for (const e of all) {
    if (e.status !== 'in_flight') continue;
    const t = e.started_at ? Date.parse(e.started_at) : 0;
    if (t < cutoff) {
      e.status = 'pending';
      delete e.started_at;
      count++;
    }
  }
  if (count > 0) writeAll(all);
  return count;
}

/**
 * Compact the queue: drop entries marked done older than `olderThanMs`.
 * Returns the number of entries dropped.
 */
export function compact(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
  const all = readAll();
  const cutoff = Date.now() - olderThanMs;
  const kept = all.filter((e) => {
    if (e.status !== 'done') return true;
    const t = e.completed_at ? Date.parse(e.completed_at) : Date.now();
    return t >= cutoff;
  });
  const dropped = all.length - kept.length;
  if (dropped > 0) writeAll(kept);
  return dropped;
}

// ============================================================================
// Drain lock (Phase 3a-5)
// ----------------------------------------------------------------------------
// Prevents concurrent drain processes from racing on the queue file. The lock
// is OS-level via O_EXCL ('wx' flag). Stale locks (> LOCK_STALE_MS old) are
// reclaimable — protects against a drain killed without releasing the lock.
//
// Two clients use this:
//   - synth-drain.js main()                  — wraps the --all loop
//   - session-start.js catch-up kick         — checks isDrainLocked() before spawn
//
// The lock content is JSON {pid, started_at} purely for diagnostics; only
// existence + mtime are load-bearing.
// ============================================================================
const LOCK_FILE = path.join(QUEUE_DIR, 'synth-drain.lock');
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 min — bigger than any real drain

/**
 * Try to acquire the drain lock. Returns true on success, false if held by
 * a non-stale drain. Stale locks are silently reclaimed.
 */
export function acquireDrainLock() {
  ensureQueueDir();
  const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx'); // O_EXCL | O_CREAT | O_WRONLY
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
    // Lock exists — check if stale.
    try {
      const st = fs.statSync(LOCK_FILE);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // Stale — overwrite. There's a tiny TOCTOU race here but the
        // worst case is two drains briefly running, which is bounded
        // by the per-drain --max cap and per-task atomicity.
        fs.unlinkSync(LOCK_FILE);
        const fd2 = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd2, payload);
        fs.closeSync(fd2);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}

/**
 * Release the drain lock. Idempotent — never throws if the lock doesn't exist.
 */
export function releaseDrainLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* fine */ }
}

/**
 * Read-only check: is a non-stale drain currently running?
 * Cheap — just stat the lock file. Used by SessionStart catch-up to skip
 * spawning a redundant drain.
 */
export function isDrainLocked() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  try {
    const st = fs.statSync(LOCK_FILE);
    return Date.now() - st.mtimeMs <= LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export const _internals = { QUEUE_FILE, LOCK_FILE, readAll, writeAll };

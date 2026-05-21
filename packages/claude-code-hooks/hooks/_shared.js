/**
 * Shared helpers for sandbox hooks. Mirrors the upstream contract:
 *   - read JSON from stdin (with a 2s read timeout)
 *   - write JSON output to stdout
 *   - never throw, always exit 0
 */
const STDIN_READ_TIMEOUT_MS = 2000;

export async function readStdinJson(timeoutMs = STDIN_READ_TIMEOUT_MS) {
  if (process.stdin.isTTY) return {};
  const raw = await new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
  if (!raw || raw.trim().length === 0) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function emitStdout(obj) {
  if (obj === undefined || obj === null) return;
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Wraps a body so any thrown error is swallowed and exit is 0.
 * Optional total budget timer.
 */
export async function runHookBody(name, budgetMs, body) {
  // Short-circuit when running inside a hive-mind synth-drain subprocess.
  // Without this, claude -p subprocesses would fire their own Stop hook,
  // enqueueing a fresh synth task per drained task — a 1:1 self-replicating
  // queue that never reaches zero. See synth-drain.js spawn options.
  if (process.env.HIVE_MIND_NO_SYNTH === '1') {
    process.exit(0);
  }
  let done = false;
  const budgetTimer = setTimeout(() => {
    if (done) return;
    done = true;
    // exit silently — host already lost the budget
    process.exit(0);
  }, budgetMs);
  try {
    await body();
  } catch (err) {
    // swallow
    process.stderr.write(`[${name}] failed open: ${err && err.message ? err.message : String(err)}\n`);
  } finally {
    done = true;
    clearTimeout(budgetTimer);
    process.exit(0);
  }
}

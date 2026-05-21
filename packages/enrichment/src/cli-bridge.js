/**
 * CLI bridge: spawns hive-mind-cli `mcp call <tool>` with JSON args.
 * Returns parsed result. Never throws — failures return {ok:false, error}.
 *
 * CLI resolution order (first hit wins, cached after first call):
 *   1. HIVE_MIND_CLI env var (explicit override)
 *   2. Plugin-local CLI: walk up from this file looking for ../cli/dist/index.js
 *      (works when installed as a Claude Code plugin or in a monorepo checkout)
 *   3. require.resolve('@hive-mind/cli/dist/index.js') (works when @hive-mind/cli
 *      is installed via npm — globally or as a project dep)
 *   4. Fallback: spawn `npx -y @hive-mind/cli` directly (slow first call, cached)
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_TIMEOUT_MS = 4000;

function findLocalCli() {
  // Walk up from packages/enrichment/src/ looking for sibling packages/cli/dist/
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'cli', 'dist', 'index.js');
    if (existsSync(candidate)) {
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* skip */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findNpmCli() {
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('@hive-mind/cli/dist/index.js');
  } catch { return null; }
}

let _cachedCli = null;

export function getCliPath() {
  if (_cachedCli !== null) return _cachedCli;
  if (process.env.HIVE_MIND_CLI && existsSync(process.env.HIVE_MIND_CLI)) {
    _cachedCli = process.env.HIVE_MIND_CLI;
    return _cachedCli;
  }
  const local = findLocalCli();
  if (local) { _cachedCli = local; return local; }
  const npmResolved = findNpmCli();
  if (npmResolved) { _cachedCli = npmResolved; return npmResolved; }
  _cachedCli = null;
  return null;
}

function getCliCommand() {
  const cli = getCliPath();
  if (cli) return { argv: [process.execPath, cli], shell: false };
  // Fallback: shell:true is required on Windows so the npx.cmd shim resolves
  return { argv: ['npx', '-y', '@hive-mind/cli'], shell: true };
}

function getLogDir() {
  return path.join(os.homedir(), '.hive-mind', 'logs');
}

async function logError(tag, payload) {
  try {
    const dir = getLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `enrichment-${date}.log`);
    const line = JSON.stringify({ ts: new Date().toISOString(), tag, ...payload }) + '\n';
    await fs.appendFile(file, line, 'utf8');
  } catch {
    // swallow — never let logging break a hook
  }
}

/**
 * Unwraps the MCP-style { ok, content:[{type:'text', text:'<json>'}] }
 * envelope into the inner JS value. Returns raw value if no envelope.
 */
function unwrapMcpResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed.ok === false) return { ok: false, error: parsed.error || 'tool returned ok:false' };
  if (Array.isArray(parsed.content) && parsed.content.length > 0) {
    const item = parsed.content[0];
    if (item && typeof item.text === 'string') {
      try {
        return { ok: true, data: JSON.parse(item.text) };
      } catch {
        return { ok: true, data: item.text };
      }
    }
  }
  return { ok: true, data: parsed };
}

/**
 * @param {string} toolName
 * @param {object} args
 * @param {{timeoutMs?:number, cliPath?:string}} [opts]
 * @returns {Promise<{ok:boolean, data?:any, error?:string}>}
 */
export function callMcp(toolName, args = {}, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cli = opts.cliPath
      ? { argv: [process.execPath, opts.cliPath], shell: false }
      : getCliCommand();
    const argsJson = JSON.stringify(args);
    const child = spawn(
      cli.argv[0],
      [...cli.argv.slice(1), 'mcp', 'call', toolName, '--args', argsJson, '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: cli.shell }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      void logError('cli-bridge', { tool: toolName, error: 'timeout', timeoutMs });
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void logError('cli-bridge', { tool: toolName, error: err.message });
      resolve({ ok: false, error: err.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        void logError('cli-bridge', { tool: toolName, code, stderr: stderr.slice(0, 500) });
        resolve({ ok: false, error: `exit ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(unwrapMcpResult(parsed));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void logError('cli-bridge', { tool: toolName, error: 'parse-failed', msg, stdout: stdout.slice(0, 500) });
        resolve({ ok: false, error: `parse failed: ${msg}` });
      }
    });
  });
}

export { getCliPath };

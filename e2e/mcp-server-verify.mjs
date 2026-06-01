#!/usr/bin/env node
/**
 * MCP server handshake + clean-install (publish) check.
 *
 * Spawns the stdio MCP server exactly as a client (Claude Code / Desktop / Codex)
 * would launch it — `node packages/mcp-server/dist/index.js` — and drives a real
 * JSON-RPC handshake over stdio:
 *   initialize -> notifications/initialized -> tools/list -> tools/call.
 * Asserts the protocol negotiates, all 21 tools register by name, and a live
 * tools/call (compile_health) actually executes through the server.
 *
 * Then runs `npm pack --dry-run` on every publishable @hive-mind package to
 * confirm the `files` allowlists resolve — the clean-install / publish readiness
 * signal (what a fresh `npm i` would actually receive).
 *
 * Usage:  npm run e2e:mcp-server   (or: node e2e/mcp-server-verify.mjs). Needs npm run build.
 * Exit 0 = handshake + 21 tools + live call + all packs OK.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed, fixtureEnv } from './seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'packages', 'mcp-server', 'dist', 'index.js');
const DATA_DIR = path.join(REPO, '.e2e-tmp', 'mind-server');

const EXPECTED_TOOLS = [
  'recall_memory', 'save_memory',
  'search_entities', 'save_entity', 'create_relation',
  'get_identity', 'set_identity',
  'get_awareness', 'set_awareness', 'clear_awareness',
  'list_workspaces', 'create_workspace',
  'harvest_sources', 'harvest_import',
  'ingest_source',
  'cleanup_frames', 'cleanup_entities',
  'compile_wiki', 'search_wiki', 'get_page', 'compile_health',
];

const PUBLISHABLE = ['core', 'enrichment', 'wiki-compiler', 'cli', 'mcp-server', 'wiki-web'];

function handshake() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...fixtureEnv(DATA_DIR) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const responses = new Map();
    const waiters = new Map();
    let stderr = '';

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) {
            responses.set(msg.id, msg);
            const w = waiters.get(msg.id);
            if (w) { w(msg); waiters.delete(msg.id); }
          }
        } catch { /* non-JSON line (banner) — ignore */ }
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
    const waitFor = (id, ms = 20_000) => new Promise((res, rej) => {
      if (responses.has(id)) return res(responses.get(id));
      waiters.set(id, res);
      setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error(`timeout waiting for id=${id}`)); } }, ms);
    });

    (async () => {
      const out = { ok: false };
      try {
        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-verify', version: '1.0.0' } } });
        const init = await waitFor(1);
        out.protocolVersion = init?.result?.protocolVersion;
        out.serverInfo = init?.result?.serverInfo;

        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        const list = await waitFor(2);
        out.tools = (list?.result?.tools || []).map((t) => t.name).sort();

        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'compile_health', arguments: {} } });
        const callRes = await waitFor(3);
        const text = callRes?.result?.content?.[0]?.text;
        try { out.callData = JSON.parse(text); } catch { out.callData = text; }

        out.ok = true;
      } catch (err) {
        out.error = err.message;
        out.stderr = stderr.slice(0, 300);
      } finally {
        try { child.kill('SIGTERM'); } catch { /* noop */ }
        resolve(out);
      }
    })();
  });
}

function packCheck(pkg) {
  const res = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts'], {
    cwd: path.join(REPO, 'packages', pkg), encoding: 'utf8', timeout: 120_000, shell: true,
  });
  return res.status === 0;
}

async function main() {
  process.stdout.write(`[e2e:mcp-server] seeding fixture -> ${DATA_DIR}\n`);
  seed(DATA_DIR);

  process.stdout.write('[e2e:mcp-server] JSON-RPC handshake over stdio\n');
  const h = await handshake();

  const checks = [];
  checks.push({ name: 'initialize negotiates protocol', ok: !!h.protocolVersion, detail: `protocol=${h.protocolVersion} server=${h.serverInfo?.name}` });
  const got = h.tools || [];
  const expected = [...EXPECTED_TOOLS].sort();
  const missing = expected.filter((t) => !got.includes(t));
  const extra = got.filter((t) => !expected.includes(t));
  checks.push({ name: 'all 21 tools register', ok: got.length === 21 && missing.length === 0, detail: `count=${got.length}${missing.length ? ' missing=' + missing.join(',') : ''}${extra.length ? ' extra=' + extra.join(',') : ''}` });
  checks.push({ name: 'live tools/call (compile_health)', ok: h.callData && typeof h.callData === 'object' && typeof h.callData.data_quality_score === 'number', detail: h.callData?.data_quality_score != null ? `score=${h.callData.data_quality_score}` : 'no score' });

  process.stdout.write('[e2e:mcp-server] npm pack --dry-run on publishable packages\n');
  for (const pkg of PUBLISHABLE) {
    checks.push({ name: `pack @hive-mind/${pkg}`, ok: packCheck(pkg), detail: 'files allowlist resolves' });
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    process.stdout.write(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(34)} ${c.detail || ''}\n`);
  }
  process.stdout.write(`[e2e:mcp-server] ${checks.length - failed}/${checks.length} checks passed\n`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => { process.stderr.write(`[e2e:mcp-server] crashed: ${err.stack || err.message}\n`); process.exit(1); });

#!/usr/bin/env node
/**
 * Browserless end-to-end verification for hive-mind wiki-web.
 *
 * Seeds a deterministic fixture, boots the real server (which reads through the
 * CLI bridge -> MindDB -> SQLite/FTS5), then asserts the HTML/JSON of every
 * route. No browser, no Playwright install — runs anywhere Node 20+ runs, so
 * it is the CI-friendly backbone of the E2E suite.
 *
 * This is the regression guard for the two bugs found on 2026-06-01:
 *   - a duplicate export that crashed the server on boot  -> "server never
 *     listened" FAIL here;
 *   - /entity/:id 404 (id used as a name query)           -> entity assertion
 *     FAIL here.
 *
 * Usage:  npm run e2e:http     (or:  node e2e/http-verify.mjs)
 *   PORT defaults to 3941; fixture lives in <repo>/.e2e-tmp/mind-http.
 * Exit code 0 = all checks passed, 1 = one or more failed (or boot failed).
 *
 * Requires a built CLI (npm run build) — the server shells out to
 * packages/cli/dist/index.js.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed, fixtureEnv } from './seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'packages', 'wiki-web', 'src', 'server.js');
const PORT = Number(process.env.PORT) || 3941;
const DATA_DIR = path.join(REPO, '.e2e-tmp', 'mind-http');
const BASE = `http://localhost:${PORT}`;

const FRAME1 =
  'ZephyrFixture: Hive Mind is a local-first AI memory system built on SQLite with hybrid search.';

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** Each check fetches one path and returns { ok, detail }. */
const checks = [
  {
    name: 'home shows real health + wiki list',
    url: '/',
    async run() {
      const r = await fetch(BASE + '/');
      const t = await r.text();
      const ok =
        r.status === 200 &&
        t.includes('data_quality_score: 90') &&
        t.includes('total_entities: 5') &&
        t.includes('total_frames: 6') &&
        t.includes('total_pages: 6') &&
        t.includes('/wiki/hive-mind');
      return { ok, detail: `status=${r.status} bytes=${t.length}` };
    },
  },
  {
    name: 'search returns 6 seeded frames',
    url: '/search?q=ZephyrFixture',
    async run() {
      const r = await fetch(BASE + '/search?q=ZephyrFixture');
      const t = await r.text();
      const hits = countOccurrences(t, 'ZephyrFixture');
      const ok = r.status === 200 && t.includes('value="ZephyrFixture"') && hits >= 6;
      return { ok, detail: `status=${r.status} ZephyrFixture x${hits}` };
    },
  },
  {
    name: 'entity/1 resolves (regression: was 404)',
    url: '/entity/1',
    async run() {
      const r = await fetch(BASE + '/entity/1');
      const t = await r.text();
      const ok =
        r.status === 200 &&
        t.includes('Hive Mind') &&
        t.includes('type: project') &&
        t.includes('works_on') &&
        !t.includes('entity not found');
      return { ok, detail: `status=${r.status}` };
    },
  },
  {
    name: 'entity/999999 correctly 404s',
    url: '/entity/999999',
    async run() {
      const r = await fetch(BASE + '/entity/999999');
      return { ok: r.status === 404, detail: `status=${r.status}` };
    },
  },
  {
    name: 'frame/1 shows content',
    url: '/frame/1',
    async run() {
      const r = await fetch(BASE + '/frame/1');
      const t = await r.text();
      const ok = r.status === 200 && t.includes(FRAME1) && t.includes('user_stated');
      return { ok, detail: `status=${r.status}` };
    },
  },
  {
    name: 'graph page renders shell + api hook',
    url: '/graph',
    async run() {
      const r = await fetch(BASE + '/graph');
      const t = await r.text();
      const ok = r.status === 200 && t.includes('Knowledge graph') && t.includes('/api/graph');
      return { ok, detail: `status=${r.status}` };
    },
  },
  {
    name: 'wiki/hive-mind shows article + sources',
    url: '/wiki/hive-mind',
    async run() {
      const r = await fetch(BASE + '/wiki/hive-mind');
      const t = await r.text();
      const ok = r.status === 200 && t.includes('Hive Mind') && /source frames/i.test(t);
      return { ok, detail: `status=${r.status}` };
    },
  },
  {
    name: 'api/search returns >=6 frames (JSON)',
    url: '/api/search?q=ZephyrFixture',
    async run() {
      const r = await fetch(BASE + '/api/search?q=ZephyrFixture');
      const j = await r.json();
      const n = Array.isArray(j.frames) ? j.frames.length : -1;
      return { ok: r.status === 200 && n >= 6, detail: `status=${r.status} frames=${n}` };
    },
  },
  {
    name: 'api/graph returns 5 nodes + 4 edges (JSON)',
    url: '/api/graph',
    async run() {
      const r = await fetch(BASE + '/api/graph');
      const j = await r.json();
      const nodes = Array.isArray(j.nodes) ? j.nodes.length : -1;
      const edges = Array.isArray(j.edges) ? j.edges.length : -1;
      return { ok: r.status === 200 && nodes === 5 && edges === 4, detail: `nodes=${nodes} edges=${edges}` };
    },
  },
];

async function waitForListen(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

async function main() {
  process.stdout.write(`[e2e:http] seeding fixture -> ${DATA_DIR}\n`);
  seed(DATA_DIR);

  process.stdout.write(`[e2e:http] booting server on ${BASE}\n`);
  const env = { ...fixtureEnv(DATA_DIR), PORT: String(PORT) };
  const server = spawn(process.execPath, [SERVER], { env, stdio: 'pipe' });
  let serverErr = '';
  server.stderr.on('data', (c) => (serverErr += c.toString()));
  server.stdout.on('data', () => {});

  let failed = 0;
  try {
    const up = await waitForListen();
    if (!up) {
      process.stderr.write(`[e2e:http] FAIL: server never listened on ${BASE}\n`);
      if (serverErr) process.stderr.write(serverErr.slice(0, 800) + '\n');
      return 1;
    }

    for (const c of checks) {
      let res;
      try {
        res = await c.run();
      } catch (err) {
        res = { ok: false, detail: `threw: ${err.message}` };
      }
      const mark = res.ok ? 'PASS' : 'FAIL';
      if (!res.ok) failed++;
      process.stdout.write(`  [${mark}] ${c.name.padEnd(44)} ${res.detail}\n`);
    }
  } finally {
    server.kill('SIGTERM');
  }

  process.stdout.write(
    `[e2e:http] ${checks.length - failed}/${checks.length} checks passed\n`,
  );
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[e2e:http] crashed: ${err.stack || err.message}\n`);
    process.exit(1);
  });

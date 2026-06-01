#!/usr/bin/env node
/**
 * End-to-end verification of all 21 MCP tools through the real CLI bridge.
 *
 * The wiki-web harness (http-verify.mjs) exercises ~8 tools transitively; this
 * script drives ALL 21 directly via `node <cli> mcp call <tool> --args <json>
 * --json` — the exact path MCP clients use — and asserts each returns a correct,
 * non-error result. Destructive cleanup modes are NOT exercised (only the
 * non-destructive `compact` / `audit` modes).
 *
 * Usage:  npm run e2e:mcp-tools   (or: node e2e/mcp-tools-verify.mjs)
 *   Fixture: <repo>/.e2e-tmp/mind-tools. Requires a built CLI (npm run build).
 * Exit 0 = all 21 tools passed.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed, fixtureEnv } from './seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'packages', 'cli', 'dist', 'index.js');
const DATA_DIR = path.join(REPO, '.e2e-tmp', 'mind-tools');

const env = fixtureEnv(DATA_DIR);

/** Call a tool; returns { isError, data } where data is the unwrapped payload. */
function call(tool, args) {
  const res = spawnSync(
    process.execPath,
    [CLI, 'mcp', 'call', tool, '--args', JSON.stringify(args), '--json'],
    { env, encoding: 'utf8', timeout: 90_000 },
  );
  if (res.status !== 0) return { isError: true, data: `exit ${res.status}: ${(res.stderr || '').slice(0, 200)}` };
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch { return { isError: true, data: `bad JSON: ${(res.stdout || '').slice(0, 160)}` }; }
  if (parsed && parsed.ok === false) return { isError: true, data: parsed.error };
  const isError = !!(parsed && parsed.isError);
  let data = parsed;
  if (Array.isArray(parsed?.content) && parsed.content[0]?.text != null) {
    const text = parsed.content[0].text;
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { isError, data };
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const ok = (cond, detail) => ({ ok: !!cond, detail });

// Shared ids captured across checks.
const ids = {};

// Each check: { group, tool, run() -> {ok, detail} }. Ordered (some depend on prior).
const checks = [
  // ── Memory ──
  { tool: 'save_memory', run: () => { const r = call('save_memory', { content: 'E2E tool check token QWERTYZED', importance: 'normal', source: 'user_stated' }); ids.frame = r.data?.id; return ok(!r.isError && Number.isInteger(r.data?.id), `id=${r.data?.id}`); } },
  { tool: 'recall_memory', run: () => { const r = call('recall_memory', { query: 'QWERTYZED', scope: 'personal', limit: 10 }); const hit = Array.isArray(r.data) && r.data.some((f) => String(f.content).includes('QWERTYZED')); return ok(!r.isError && hit, Array.isArray(r.data) ? `${r.data.length} hits` : String(r.data).slice(0, 40)); } },
  // ── Knowledge ──
  { tool: 'save_entity', run: () => { const r = call('save_entity', { type: 'tool', name: 'E2E Tool Entity' }); ids.entity = r.data?.id; return ok(!r.isError && Number.isInteger(r.data?.id), `id=${r.data?.id}`); } },
  { tool: 'search_entities', run: () => { const r = call('search_entities', { query: 'E2E Tool Entity' }); const hit = Array.isArray(r.data) && r.data.some((e) => e.name === 'E2E Tool Entity'); return ok(!r.isError && hit, Array.isArray(r.data) ? `${r.data.length} found` : String(r.data).slice(0, 40)); } },
  { tool: 'create_relation', run: () => { const r = call('create_relation', { source_id: ids.entity, target_id: 1, relation_type: 'relates_to' }); return ok(!r.isError && Number.isInteger(r.data?.id), `rel id=${r.data?.id}`); } },
  // ── Wiki ──
  { tool: 'compile_wiki', run: () => { const r = call('compile_wiki', { mode: 'incremental' }); return ok(!r.isError && isObj(r.data) && ('pages_created' in r.data || 'pages_updated' in r.data), isObj(r.data) ? `created=${r.data.pages_created} updated=${r.data.pages_updated}` : 'n/a'); } },
  { tool: 'search_wiki', run: () => { const r = call('search_wiki', {}); return ok(!r.isError && Array.isArray(r.data) && r.data.length > 0, Array.isArray(r.data) ? `${r.data.length} pages` : String(r.data).slice(0, 40)); } },
  { tool: 'get_page', run: () => { const r = call('get_page', { slug: 'hive-mind' }); return ok(!r.isError && (isObj(r.data) ? r.data.slug === 'hive-mind' : /hive-mind/.test(String(r.data))), isObj(r.data) ? `slug=${r.data.slug}` : String(r.data).slice(0, 40)); } },
  { tool: 'compile_health', run: () => { const r = call('compile_health', {}); return ok(!r.isError && isObj(r.data) && typeof r.data.data_quality_score === 'number', isObj(r.data) ? `score=${r.data.data_quality_score} entities=${r.data.total_entities}` : 'n/a'); } },
  // ── Identity ──
  { tool: 'get_identity (pre)', run: () => { const r = call('get_identity', {}); return ok(!r.isError && isObj(r.data) && 'configured' in r.data, `configured=${r.data?.configured}`); } },
  { tool: 'set_identity', run: () => { const r = call('set_identity', { name: 'E2E User', role: 'Tester' }); return ok(!r.isError && isObj(r.data) && (r.data.action === 'created' || r.data.action === 'updated'), `action=${r.data?.action}`); } },
  { tool: 'get_identity (post)', run: () => { const r = call('get_identity', {}); return ok(!r.isError && r.data?.configured === true && r.data?.name === 'E2E User', `name=${r.data?.name}`); } },
  // ── Awareness ──
  { tool: 'set_awareness', run: () => { const r = call('set_awareness', { category: 'task', content: 'E2E awareness task' }); ids.aware = r.data?.id; return ok(!r.isError && Number.isInteger(r.data?.id), `id=${r.data?.id}`); } },
  { tool: 'get_awareness', run: () => { const r = call('get_awareness', {}); const hit = Array.isArray(r.data) && r.data.some((a) => a.content === 'E2E awareness task'); return ok(!r.isError && hit, Array.isArray(r.data) ? `${r.data.length} items` : String(r.data).slice(0, 40)); } },
  { tool: 'clear_awareness', run: () => { const r = call('clear_awareness', { category: 'task' }); return ok(!r.isError && /Cleared/.test(String(r.data)), String(r.data).slice(0, 40)); } },
  // ── Workspace ──
  { tool: 'list_workspaces', run: () => { const r = call('list_workspaces', {}); return ok(!r.isError && isObj(r.data) && 'personal' in r.data && Array.isArray(r.data.workspaces), isObj(r.data) ? `personal.frames=${r.data.personal?.frames} ws=${r.data.workspaces?.length}` : 'n/a'); } },
  { tool: 'create_workspace', run: () => { const r = call('create_workspace', { name: 'E2E WS' }); return ok(!r.isError && isObj(r.data) && typeof r.data.id === 'string', `id=${r.data?.id}`); } },
  // ── Ingest ──
  { tool: 'ingest_source', run: () => { const r = call('ingest_source', { content: '# E2E Doc\n\nZephyr ingest body content for the tool check.', type_hint: 'markdown' }); return ok(!r.isError && isObj(r.data) && 'frames_created' in r.data, isObj(r.data) ? `type=${r.data.source_type} frames=${r.data.frames_created}` : 'n/a'); } },
  // ── Harvest ──
  { tool: 'harvest_import', run: () => { const data = JSON.stringify([{ title: 'E2E conv', content: 'A harvested conversation body.', source: 'universal' }]); const r = call('harvest_import', { source: 'universal', data }); return ok(!r.isError && isObj(r.data) && 'frames_created' in r.data || /No conversations/.test(String(r.data)), isObj(r.data) ? `found=${r.data.items_found} frames=${r.data.frames_created}` : String(r.data).slice(0, 40)); } },
  { tool: 'harvest_sources', run: () => { const r = call('harvest_sources', {}); return ok(!r.isError && (Array.isArray(r.data) || /No harvest sources/.test(String(r.data))), Array.isArray(r.data) ? `${r.data.length} sources` : String(r.data).slice(0, 40)); } },
  // ── Cleanup (non-destructive modes only) ──
  { tool: 'cleanup_frames (compact)', run: () => { const r = call('cleanup_frames', { mode: 'compact' }); return ok(!r.isError && isObj(r.data) && r.data.action === 'compact', isObj(r.data) ? `temp=${r.data.temporary_pruned} dep=${r.data.deprecated_pruned}` : 'n/a'); } },
  { tool: 'cleanup_entities (audit)', run: () => { const r = call('cleanup_entities', { mode: 'audit' }); return ok(!r.isError && isObj(r.data) && r.data.action === 'audit' && typeof r.data.total_entities === 'number', isObj(r.data) ? `entities=${r.data.total_entities} noise=${r.data.noise_entities}` : 'n/a'); } },
];

function main() {
  process.stdout.write(`[e2e:mcp-tools] seeding fixture -> ${DATA_DIR}\n`);
  seed(DATA_DIR);
  process.stdout.write(`[e2e:mcp-tools] exercising ${checks.length} tool calls (all 21 tools)\n`);

  let failed = 0;
  const covered = new Set();
  for (const c of checks) {
    let res;
    try { res = c.run(); } catch (err) { res = { ok: false, detail: `threw: ${err.message}` }; }
    covered.add(c.tool.replace(/ \(.*$/, '').trim());
    if (!res.ok) failed++;
    process.stdout.write(`  [${res.ok ? 'PASS' : 'FAIL'}] ${c.tool.padEnd(26)} ${res.detail}\n`);
  }
  process.stdout.write(`[e2e:mcp-tools] ${checks.length - failed}/${checks.length} checks passed across ${covered.size} distinct tools\n`);
  return failed === 0 ? 0 : 1;
}

process.exit(main());

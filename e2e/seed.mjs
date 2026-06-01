#!/usr/bin/env node
/**
 * Deterministic E2E fixture builder for hive-mind wiki-web.
 *
 * Seeds a throwaway "mind" under HIVE_MIND_DATA_DIR by calling the REAL CLI
 * bridge — `node <cli> mcp call <tool> --args <json> --json` — i.e. the exact
 * code path the wiki-web server uses at runtime (packages/enrichment/src/
 * cli-bridge.js). No backdoor into SQLite, so the fixture proves the whole
 * chain: CLI -> MCP tool handler -> MindDB -> SQLite/FTS5.
 *
 * Idempotent: wipes + rebuilds the data dir every run.
 *
 * Bulletproofing: every seeded memory carries the literal token `ZephyrFixture`
 * so recall can be asserted via FTS5/BM25 keyword match — deterministic even
 * when the embedding provider degrades to "mock" (no Ollama / no API key).
 *
 * Usage:  node e2e/seed.mjs [dataDir]
 *   dataDir defaults to <repo>/.e2e-tmp/mind
 *
 * Emits a fixture manifest (ids + a known wiki slug + the search token) to
 * <dataDir>/../fixture-manifest.json for the harness + live run to consume.
 */
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'packages', 'cli', 'dist', 'index.js');

export const SEARCH_TOKEN = 'ZephyrFixture';

export function resolveDataDir(arg) {
  return path.resolve(arg || process.env.HIVE_MIND_DATA_DIR || path.join(REPO, '.e2e-tmp', 'mind'));
}

/** Env every seeded CLI child inherits. Returned so the boot helper can reuse it. */
export function fixtureEnv(dataDir) {
  return {
    ...process.env,
    HIVE_MIND_DATA_DIR: dataDir,
    HIVE_MIND_CLI: CLI,
    HIVE_MIND_NO_RERANK: '1', // deterministic + fast; reranker path is covered separately
    HIVE_MIND_NO_SYNTH: '1',  // don't spawn LLM wiki synthesis during seeding
  };
}

function call(env, tool, args, { mutating = false } = {}) {
  const res = spawnSync(
    process.execPath,
    [CLI, 'mcp', 'call', tool, '--args', JSON.stringify(args), '--json'],
    { env, encoding: 'utf8', timeout: 90_000 },
  );
  if (res.error) throw new Error(`${tool}: spawn failed: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${tool}: exit ${res.status}: ${(res.stderr || '').slice(0, 400)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`${tool}: non-JSON stdout: ${(res.stdout || '').slice(0, 400)}`);
  }
  if (parsed && parsed.ok === false) throw new Error(`${tool}: ok:false: ${parsed.error}`);
  if (parsed && parsed.isError) {
    throw new Error(`${tool}: isError: ${JSON.stringify(parsed.content).slice(0, 400)}`);
  }
  // Unwrap MCP envelope { content:[{type:'text', text:'<json|string>'}] }
  let data = parsed;
  if (Array.isArray(parsed?.content) && parsed.content[0]?.text != null) {
    const text = parsed.content[0].text;
    try { data = JSON.parse(text); } catch { data = text; }
  }
  // Mutating tools must return a structured object — a bare string here means
  // the handler soft-failed (exit 0 + isError text) and we caught it as success.
  if (mutating && (typeof data !== 'object' || data === null)) {
    throw new Error(`${tool}: expected object result, got: ${String(data).slice(0, 200)}`);
  }
  return data;
}

export function seed(dataDirArg) {
  const dataDir = resolveDataDir(dataDirArg);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const env = fixtureEnv(dataDir);

  const log = (...a) => process.stdout.write(a.join(' ') + '\n');
  log(`[seed] data dir: ${dataDir}`);
  log(`[seed] cli:      ${CLI}`);

  // ── Entities ──────────────────────────────────────────────────────
  const project = call(env, 'save_entity', { type: 'project', name: 'Hive Mind' }, { mutating: true });
  const person = call(env, 'save_entity', { type: 'person', name: 'Marko Markovic' }, { mutating: true });
  const tech = call(env, 'save_entity', { type: 'technology', name: 'SQLite' }, { mutating: true });
  const concept = call(env, 'save_entity', { type: 'concept', name: 'Hybrid Search' }, { mutating: true });
  const org = call(env, 'save_entity', { type: 'organization', name: 'Egzakta' }, { mutating: true });
  log(`[seed] entities: project=${project.id} person=${person.id} tech=${tech.id} concept=${concept.id} org=${org.id}`);

  // ── Relations ─────────────────────────────────────────────────────
  call(env, 'create_relation', { source_id: person.id, target_id: project.id, relation_type: 'works_on' }, { mutating: true });
  call(env, 'create_relation', { source_id: project.id, target_id: tech.id, relation_type: 'uses' }, { mutating: true });
  call(env, 'create_relation', { source_id: project.id, target_id: concept.id, relation_type: 'implements' }, { mutating: true });
  call(env, 'create_relation', { source_id: person.id, target_id: org.id, relation_type: 'founder_of' }, { mutating: true });
  log('[seed] relations: 4 created');

  // ── Memories (carry SEARCH_TOKEN for deterministic FTS recall) ─────
  const memories = [
    { content: `${SEARCH_TOKEN}: Hive Mind is a local-first AI memory system built on SQLite with hybrid search.`, importance: 'important' },
    { content: `${SEARCH_TOKEN}: The reranker applies a cross-encoder over RRF-fused candidates inside recall_memory.`, importance: 'normal' },
    { content: `${SEARCH_TOKEN}: Marko Markovic founded Egzakta and leads the Hive Mind project.`, importance: 'critical' },
    { content: `${SEARCH_TOKEN}: Frames are grouped into GOPs per session; importance weights bias recall scoring.`, importance: 'normal' },
    { content: `${SEARCH_TOKEN}: HybridSearch fuses FTS5 BM25 keyword hits with sqlite-vec cosine vectors via RRF.`, importance: 'important' },
    { content: `${SEARCH_TOKEN}: The wiki compiler turns frames and entities into navigable pages.`, importance: 'normal' },
  ];
  const frameIds = [];
  for (const m of memories) {
    const f = call(env, 'save_memory', { ...m, source: 'user_stated' }, { mutating: true });
    frameIds.push(f.id);
  }
  log(`[seed] memories: ${frameIds.length} frames (${frameIds.join(',')})`);

  // ── Compile the wiki (structural entity/concept pages; no LLM needed) ──
  const compiled = call(env, 'compile_wiki', { mode: 'full' }, { mutating: true });
  log(`[seed] compile_wiki: created=${compiled.pages_created} entity=${compiled.entity_pages} concept=${compiled.concept_pages}`);

  // ── Capture a real wiki slug from search_wiki (don't guess slugify rules) ──
  const pages = call(env, 'search_wiki', {});
  const pageList = Array.isArray(pages) ? pages : [];
  const knownSlug = (pageList.find((p) => /hive/i.test(p.slug || p.name || '')) || pageList[0] || {}).slug || null;
  log(`[seed] wiki pages: ${pageList.length}, known slug: ${knownSlug}`);

  const manifest = {
    dataDir,
    cli: CLI,
    searchToken: SEARCH_TOKEN,
    entities: { project: project.id, person: person.id, tech: tech.id, concept: concept.id, org: org.id },
    frameIds,
    wiki: { pageCount: pageList.length, knownSlug, slugs: pageList.map((p) => p.slug) },
    seededAt: new Date().toISOString(),
  };
  const manifestPath = path.join(path.dirname(dataDir), 'fixture-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`[seed] manifest -> ${manifestPath}`);
  return manifest;
}

// Run when invoked directly (node e2e/seed.mjs [dataDir])
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    seed(process.argv[2]);
    process.stdout.write('[seed] OK\n');
  } catch (err) {
    process.stderr.write(`[seed] FAILED: ${err.message}\n`);
    process.exit(1);
  }
}

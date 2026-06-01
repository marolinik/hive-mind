/**
 * wiki-web Express server.
 * Reads from hive-mind via the CLI bridge (no direct SQLite).
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  callMcp,
  enqueueSynth,
  listPending,
} from '@hive-mind/enrichment';

import { renderHome } from './views/home.js';
import { renderSearch } from './views/search.js';
import { renderEntity } from './views/entity.js';
import { renderFrame } from './views/frame.js';
import { renderGraph } from './views/graph.js';
import { renderPage } from './views/page.js';

const ON_READ_DEDUP_MS = 60 * 60 * 1000; // 1h

/**
 * Enqueue a "page-dirty" synth task on read, deduped by subject within the
 * cooldown window. Returns true if a new task was enqueued, false if a
 * recent one already exists.
 */
function maybeEnqueueDirtyPage(slug) {
  try {
    const cutoff = Date.now() - ON_READ_DEDUP_MS;
    const recent = listPending(200).find(
      (e) =>
        e.kind === 'page-dirty' &&
        e.subject === slug &&
        Date.parse(e.enqueued_at || '') >= cutoff,
    );
    if (recent) return false;
    enqueueSynth({
      kind: 'page-dirty',
      subject: slug,
      context_query: `wiki page ${slug}`,
      ws_id: null, // null sentinel = use personal mind on save (NOT the string 'personal' which would create a workspace called "personal")
    });
    return true;
  } catch {
    return false;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT) || 3717;

const app = express();

// Local-first hardening: a Content-Security-Policy that only permits same-origin
// + inline assets. This BLOCKS any external script/style/connect (e.g. a CDN),
// enforcing the "zero cloud dependency" guarantee — if a CDN <script> is ever
// reintroduced, the browser refuses it instead of silently phoning home.
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Quiet the cosmetic /favicon.ico 404 without shipping a binary asset.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(PUBLIC_DIR));

function asArrayMaybe(res) {
  if (!res || !res.ok) return [];
  if (Array.isArray(res.data)) return res.data;
  if (res.data && Array.isArray(res.data.items)) return res.data.items;
  return [];
}

app.get('/', async (req, res) => {
  const [healthRes, wikiRes] = await Promise.all([
    callMcp('compile_health', {}, { timeoutMs: 4000 }),
    callMcp('search_wiki', { query: '', limit: 20 }, { timeoutMs: 4000 }),
  ]);
  const health = healthRes.ok ? healthRes.data : null;
  const wikiHits = asArrayMaybe(wikiRes);
  res.type('html').send(renderHome({ health, wikiHits }));
});

app.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.type('html').send(renderSearch({ q, frames: [], entities: [], wiki: [] }));
    return;
  }
  const [framesRes, entitiesRes, wikiRes] = await Promise.all([
    callMcp('recall_memory', { query: q, limit: 50, scope: 'personal' }, { timeoutMs: 4000 }),
    callMcp('search_entities', { query: q, limit: 50 }, { timeoutMs: 4000 }),
    callMcp('search_wiki', { query: q, limit: 50 }, { timeoutMs: 4000 }),
  ]);
  res.type('html').send(renderSearch({
    q,
    frames: asArrayMaybe(framesRes),
    entities: asArrayMaybe(entitiesRes),
    wiki: asArrayMaybe(wikiRes),
  }));
});

app.get('/entity/:id', async (req, res) => {
  const id = req.params.id;
  // No get-entity-by-id tool exists in the MCP surface yet, so enumerate (empty
  // query lists entities, capped at 200) and match by id. The previous code
  // searched for the numeric id as a *name* query, which never matched — so
  // every /entity/:id, and thus every graph-node drill-down, returned 404.
  const r = await callMcp('search_entities', { query: '', limit: 200 }, { timeoutMs: 4000 });
  let entity = null;
  if (r.ok && Array.isArray(r.data)) {
    entity = r.data.find((e) => String(e.id) === String(id)) || null;
  }
  if (!entity) {
    res.type('html').status(404).send(renderEntity({ id, entity: null, error: 'entity not found' }));
    return;
  }
  res.type('html').send(renderEntity({ id, entity }));
});

app.get('/frame/:id', async (req, res) => {
  const id = req.params.id;
  // recall by id-as-query is a best-effort fallback.
  const r = await callMcp('recall_memory', { query: `frame ${id}`, limit: 50, scope: 'personal' }, { timeoutMs: 4000 });
  const arr = asArrayMaybe(r);
  const frame = arr.find((f) => String(f.id) === String(id));
  if (!frame) {
    res.type('html').status(404).send(renderFrame({ id, frame: null, error: 'frame not found in top-50 results — try /search' }));
    return;
  }
  res.type('html').send(renderFrame({ id, frame }));
});

app.get('/graph', (_req, res) => {
  res.type('html').send(renderGraph());
});

// Compiled wiki page. Reading a page enqueues a "page-dirty" synth task
// (deduped per slug per hour) so the next drain can re-synthesize the page
// against any new source frames since the last compile.
//
// 2026-05-08: get_page returns metadata-only for entity pages (the synth
// pipeline that fills the body runs at most 10 pages/day). To make the wiki
// useful TODAY for the other ~516 unfilled pages, fall back to a recall
// query against the page name and render the matched frames as "Source
// frames (synthesis pending)". The synth body, when it eventually lands,
// supersedes this fallback automatically because page.body wins in the
// renderer's pickField order.
app.get('/wiki/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').trim();
  if (!slug) {
    res.type('html').status(400).send(renderPage({ slug, error: 'missing slug' }));
    return;
  }
  const r = await callMcp('get_page', { slug }, { timeoutMs: 4000 });
  const page = r.ok ? r.data : null;
  const error = r.ok ? null : (r.error || 'fetch failed');
  const dirtyEnqueued = page ? maybeEnqueueDirtyPage(slug) : false;

  // Fallback: when the page has no body/content/markdown/text, fetch the
  // top relevant frames for the page name and render them in a separate
  // section. Best-effort — soft fail to "empty" if recall errors.
  let sourceFrames = null;
  if (page && !page.body && !page.content && !page.markdown && !page.text) {
    const queryName = page.name || slug;
    const recallRes = await callMcp(
      'recall_memory',
      { query: queryName, scope: 'all', limit: 8, profile: 'balanced' },
      { timeoutMs: 3000 },
    );
    if (recallRes.ok && Array.isArray(recallRes.data) && recallRes.data.length > 0) {
      sourceFrames = recallRes.data;
    }
  }

  res.type('html').send(renderPage({ slug, page, error, dirtyEnqueued, sourceFrames }));
});

// JSON APIs
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const [framesRes, entitiesRes, wikiRes] = await Promise.all([
    callMcp('recall_memory', { query: q, limit: 20, scope: 'personal' }, { timeoutMs: 4000 }),
    callMcp('search_entities', { query: q, limit: 20 }, { timeoutMs: 4000 }),
    callMcp('search_wiki', { query: q, limit: 20 }, { timeoutMs: 4000 }),
  ]);
  res.json({
    frames: asArrayMaybe(framesRes),
    entities: asArrayMaybe(entitiesRes),
    wiki: asArrayMaybe(wikiRes),
  });
});

app.get('/api/graph', async (_req, res) => {
  // Build a simple graph: top entities by name search '' (return some), and use their relations.
  const r = await callMcp('search_entities', { query: '', limit: 60 }, { timeoutMs: 4000 });
  const ents = asArrayMaybe(r);
  const nodes = ents.map((e) => ({ id: e.id, label: e.name || `e${e.id}`, title: e.type || '' }));
  const edges = [];
  for (const e of ents) {
    const out = e.relations && Array.isArray(e.relations.outgoing) ? e.relations.outgoing : [];
    for (const rel of out) {
      const target = rel.target_id ?? rel.id;
      if (target == null) continue;
      edges.push({ from: e.id, to: target, label: rel.relation_type || rel.type || '' });
    }
  }
  res.json({ nodes, edges });
});

const server = app.listen(PORT, () => {
  process.stdout.write(`hive-mind wiki-web listening on http://localhost:${PORT}\n`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

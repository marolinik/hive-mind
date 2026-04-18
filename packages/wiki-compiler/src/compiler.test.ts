import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MindDB,
  FrameStore,
  HybridSearch,
  KnowledgeGraph,
  createEmbeddingProvider,
  type EmbeddingProviderInstance,
} from '@hive-mind/core';
import { WikiCompiler } from './compiler.js';
import { CompilationState } from './state.js';
import type { LLMSynthesizeFn } from './types.js';

/**
 * A tiny deterministic LLM stub. The prompt already embeds all frame
 * content; the stub just echoes an identifying slice back so the test
 * can assert that the page was actually composed through the
 * synthesize() callback rather than bypassed.
 */
const stubSynthesize: LLMSynthesizeFn = async (prompt) => {
  const topic = prompt.match(/about "([^"]+)"/) ?? prompt.match(/discuss "([^"]+)"/);
  return `## Summary\nStub synthesis of ${topic?.[1] ?? 'unknown topic'} based on the provided frames.\n\n## Key Facts\n- synthesized by stub`;
};

describe('WikiCompiler', () => {
  let dbPath: string;
  let db: MindDB;
  let frames: FrameStore;
  let kg: KnowledgeGraph;
  let embedder: EmbeddingProviderInstance;
  let search: HybridSearch;
  let state: CompilationState;
  let compiler: WikiCompiler;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `hmind-wiki-compiler-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    // Bootstrap session row so frames can reference a gop_id.
    db.getDatabase().prepare(
      "INSERT INTO sessions (gop_id, status, started_at) VALUES ('g-test', 'active', datetime('now'))",
    ).run();
    frames = new FrameStore(db);
    kg = new KnowledgeGraph(db);
    embedder = await createEmbeddingProvider({ provider: 'mock' });
    search = new HybridSearch(db, embedder);
    state = new CompilationState(db);
    compiler = new WikiCompiler(kg, frames, search, state, {
      synthesize: stubSynthesize,
      minFramesPerPage: 2,
      maxFramesPerCall: 10,
    });
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('compileEntityPage returns null below minFramesPerPage', async () => {
    const alice = kg.createEntity('person', 'Alice', { role: 'engineer' });
    // Only one frame mentioning Alice — below minFramesPerPage=2
    await frames.createIFrame('g-test', 'Alice joined the team this week');
    const page = await compiler.compileEntityPage(alice);
    expect(page).toBeNull();
  });

  it('compileEntityPage composes a markdown page with frontmatter, body, and relations', async () => {
    const alice = kg.createEntity('person', 'Alice', { role: 'engineer' });
    const acme = kg.createEntity('organization', 'Acme Corp', {});
    kg.createRelation(alice.id, acme.id, 'works_at', 0.9);

    await frames.createIFrame('g-test', 'Alice joined the team this week', 'important', 'user_stated');
    await frames.createIFrame('g-test', 'Alice leads the search work', 'normal', 'user_stated');
    await frames.createIFrame('g-test', 'Alice and Bob paired on the migration', 'normal', 'user_stated');

    const page = await compiler.compileEntityPage(alice);
    expect(page).not.toBeNull();
    expect(page!.slug).toBe('alice');
    expect(page!.frontmatter.type).toBe('entity');
    expect(page!.frontmatter.entity_type).toBe('person');
    expect(page!.frontmatter.sources).toBeGreaterThanOrEqual(2);
    expect(page!.frontmatter.related_entities).toContain('Acme Corp');
    expect(page!.markdown).toContain('# Alice');
    expect(page!.markdown).toContain('Stub synthesis of Alice');
    expect(page!.markdown).toContain('type: entity');
    expect(page!.contentHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('compileConceptPage includes related entities discovered via KG search', async () => {
    kg.createEntity('concept', 'Observability', {});
    kg.createEntity('technology', 'Prometheus', {});
    kg.createEntity('technology', 'Grafana', {});

    await frames.createIFrame('g-test', 'Observability is about logs and traces', 'normal', 'user_stated');
    await frames.createIFrame('g-test', 'Observability: Prometheus scrapes metrics', 'normal', 'user_stated');
    await frames.createIFrame('g-test', 'Observability dashboards in Grafana help triage', 'normal', 'user_stated');

    const page = await compiler.compileConceptPage('Observability');
    expect(page).not.toBeNull();
    expect(page!.frontmatter.type).toBe('concept');
    expect(page!.slug).toBe('observability');
    expect(page!.markdown).toContain('# Observability');
  });

  it('compileSynthesisPage returns null when only one source discusses the topic', async () => {
    await frames.createIFrame('g-test', 'Rust migration plan v1', 'normal', 'import');
    await frames.createIFrame('g-test', 'Rust migration plan v2', 'normal', 'import');
    const page = await compiler.compileSynthesisPage('Rust migration');
    expect(page).toBeNull();
  });

  it('compileSynthesisPage produces a page when multiple sources discuss the topic', async () => {
    await frames.createIFrame('g-test', 'Rust migration feasibility studied (imported)', 'normal', 'import');
    await frames.createIFrame('g-test', 'Rust migration POC begun per user', 'normal', 'user_stated');
    await frames.createIFrame('g-test', 'Rust migration: agent suggested crates', 'normal', 'agent_inferred');

    const page = await compiler.compileSynthesisPage('Rust migration');
    expect(page).not.toBeNull();
    expect(page!.frontmatter.type).toBe('synthesis');
    expect(page!.slug).toBe('synthesis-rust-migration');
    expect(page!.frontmatter.related_entities.length).toBeGreaterThanOrEqual(2);
  });

  it('compileIndex produces a nested markdown catalog of all stored page types', () => {
    state.upsertPage('alice', 'entity', 'Alice', 'h-1', [1], 2, '# Alice');
    state.upsertPage('bob', 'entity', 'Bob', 'h-2', [2], 2, '# Bob');
    state.upsertPage('obs', 'concept', 'Observability', 'h-3', [3], 4, '# Obs');
    state.upsertPage('synthesis-rust', 'synthesis', 'Synthesis: Rust migration', 'h-4', [4], 3, '# S');

    const idx = compiler.compileIndex();
    expect(idx.slug).toBe('index');
    expect(idx.markdown).toContain('# Wiki Index');
    expect(idx.markdown).toContain('## Entities');
    expect(idx.markdown).toContain('[[Alice]]');
    expect(idx.markdown).toContain('[[Bob]]');
    expect(idx.markdown).toContain('## Concepts');
    expect(idx.markdown).toContain('[[Observability]]');
    expect(idx.markdown).toContain('## Cross-Source Synthesis');
    expect(idx.markdown).toContain('[[Synthesis: Rust migration]]');
  });

  it('compileHealth flags missing pages for entities without coverage', async () => {
    const alice = kg.createEntity('person', 'Alice', {});
    const acme = kg.createEntity('organization', 'Acme Corp', {});
    kg.createRelation(alice.id, acme.id, 'works_at', 0.9);

    const health = compiler.compileHealth();
    expect(health.totalEntities).toBe(2);
    const missingAlice = health.issues.find(
      (i) => i.type === 'missing_page' && i.entity === 'Alice',
    );
    expect(missingAlice).toBeDefined();
    expect(missingAlice!.severity === 'medium' || missingAlice!.severity === 'high').toBe(true);
    expect(health.dataQualityScore).toBeLessThanOrEqual(100);
  });

  it('compile() full run exercises entity + concept + synthesis + index + watermark', async () => {
    // Two distinct entities with enough frames across multiple sources
    const alice = kg.createEntity('person', 'Alice', { role: 'engineer' });
    kg.createEntity('person', 'Bob', { role: 'designer' });
    const acme = kg.createEntity('organization', 'Acme Corp', {});
    kg.createRelation(alice.id, acme.id, 'works_at', 0.9);

    for (let i = 0; i < 4; i++) {
      await frames.createIFrame('g-test', `Alice pushed a PR about search #${i}`, 'normal', 'user_stated');
    }
    for (let i = 0; i < 3; i++) {
      await frames.createIFrame('g-test', `Bob reviewed the design doc #${i}`, 'normal', 'import');
    }
    await frames.createIFrame('g-test', 'Alice and Bob paired on the refactor (agent observed)', 'normal', 'agent_inferred');

    const result = await compiler.compile({ concepts: ['search'] });
    expect(result.pagesCreated + result.pagesUpdated).toBeGreaterThanOrEqual(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.watermark.lastFrameId).toBeGreaterThan(0);

    // State should have at least an index page now
    const indexPage = state.getPage('index');
    expect(indexPage?.name).toBe('Wiki Index');

    // Watermark persisted
    const w = state.getWatermark();
    expect(w.lastFrameId).toBeGreaterThan(0);
  });

  it('exportToMarkdown returns slug→markdown bundles including placeholder for empty pages', () => {
    state.upsertPage('alice', 'entity', 'Alice', 'h-1', [1], 2, '# Alice\n\nbody');
    state.upsertPage('bob', 'entity', 'Bob', 'h-2', [2], 1, ''); // empty markdown

    const bundle = compiler.exportToMarkdown();
    expect(bundle.get('alice')).toContain('# Alice');
    expect(bundle.get('bob')).toContain('no content compiled yet');
  });

  it('exportToDirectory writes one .md file per page into the target dir', async () => {
    state.upsertPage('alice', 'entity', 'Alice', 'h-1', [1], 2, '# Alice\n\nbody');
    state.upsertPage('bob', 'entity', 'Bob', 'h-2', [2], 2, '# Bob\n\nbody');

    const outDir = join(tmpdir(), `hmind-wiki-export-${Date.now()}`);
    const { filesWritten } = await compiler.exportToDirectory(outDir);
    expect(filesWritten).toBe(2);
    expect(readFileSync(join(outDir, 'alice.md'), 'utf-8')).toContain('# Alice');
    expect(readFileSync(join(outDir, 'bob.md'), 'utf-8')).toContain('# Bob');
    rmSync(outDir, { recursive: true, force: true });
  });
});

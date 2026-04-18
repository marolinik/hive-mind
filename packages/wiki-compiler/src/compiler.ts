/**
 * Wiki Compiler — compiles memory frames + KG into interlinked wiki pages.
 *
 * Core compilation functions:
 * - compileEntityPage() — entity → frames + relations → LLM → markdown
 * - compileConceptPage() — topic → search → LLM → markdown
 * - compileSynthesisPage() — cross-source pattern detection
 * - compileIndex() — navigable catalog
 * - compileHealth() — contradictions, gaps, data quality
 */

import type {
  KnowledgeGraph,
  FrameStore,
  HybridSearch,
  Entity,
} from '@hive-mind/core';
import type {
  WikiPage,
  WikiPageType,
  CompilerConfig,
  CompilationResult,
  HealthReport,
  HealthIssue,
} from './types.js';
import { CompilationState, contentHash } from './state.js';
import { entityPagePrompt, conceptPagePrompt, synthesisPagePrompt } from './prompts.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function buildFrontmatter(
  type: WikiPageType,
  name: string,
  frameIds: number[],
  relatedEntities: string[],
  confidence: number,
  entityType?: string,
): string {
  const lines = [
    '---',
    `type: ${type}`,
    ...(entityType ? [`entity_type: ${entityType}`] : []),
    `name: "${name.replace(/"/g, '\\"')}"`,
    `confidence: ${confidence.toFixed(2)}`,
    `sources: ${frameIds.length}`,
    `last_compiled: ${new Date().toISOString()}`,
    `frame_ids: [${frameIds.join(', ')}]`,
    `related_entities: [${relatedEntities.map(e => `"${e}"`).join(', ')}]`,
    '---',
  ];
  return lines.join('\n');
}

export class WikiCompiler {
  private kg: KnowledgeGraph;
  private frames: FrameStore;
  private search: HybridSearch;
  private state: CompilationState;
  private config: Required<CompilerConfig>;

  constructor(
    kg: KnowledgeGraph,
    frames: FrameStore,
    search: HybridSearch,
    state: CompilationState,
    config: CompilerConfig,
  ) {
    this.kg = kg;
    this.frames = frames;
    this.search = search;
    this.state = state;
    this.config = {
      synthesize: config.synthesize,
      outputDir: config.outputDir ?? 'wiki',
      minFramesPerPage: config.minFramesPerPage ?? 2,
      maxFramesPerCall: config.maxFramesPerCall ?? 30,
      minConfidence: config.minConfidence ?? 0.3,
    };
  }

  // ── Entity Page ───────────────────────────────────────────────

  async compileEntityPage(entity: Entity): Promise<WikiPage | null> {
    // Gather frames mentioning this entity
    const searchResults = await this.search.search(entity.name, {
      limit: this.config.maxFramesPerCall,
    });

    const frameData = searchResults.map(r => ({
      id: r.frame.id,
      content: r.frame.content,
      created_at: r.frame.created_at,
    }));

    if (frameData.length < this.config.minFramesPerPage) {
      return null; // Not enough data for a page
    }

    // Gather relations
    const outRels = this.kg.getRelationsFrom(entity.id);
    const inRels = this.kg.getRelationsTo(entity.id);
    const relations: { target: string; relationType: string; confidence: number }[] = [];
    const relatedEntities: string[] = [];

    for (const rel of outRels) {
      const target = this.kg.getEntity(rel.target_id);
      if (target && target.valid_to === null) {
        relations.push({ target: target.name, relationType: rel.relation_type, confidence: rel.confidence });
        relatedEntities.push(target.name);
      }
    }
    for (const rel of inRels) {
      const source = this.kg.getEntity(rel.source_id);
      if (source && source.valid_to === null) {
        relations.push({ target: source.name, relationType: `${rel.relation_type} (inbound)`, confidence: rel.confidence });
        if (!relatedEntities.includes(source.name)) {
          relatedEntities.push(source.name);
        }
      }
    }

    // Synthesize via LLM
    const prompt = entityPagePrompt(entity.name, entity.entity_type, frameData, relations);
    const body = await this.config.synthesize(prompt);

    const frameIds = frameData.map(f => f.id);
    const confidence = frameData.length > 5 ? 0.9 : frameData.length > 2 ? 0.7 : 0.5;
    const slug = slugify(entity.name);

    const frontmatter = buildFrontmatter('entity', entity.name, frameIds, relatedEntities, confidence, entity.entity_type);
    const markdown = `${frontmatter}\n\n# ${entity.name}\n\n${body}`;

    return {
      slug,
      frontmatter: {
        type: 'entity',
        entity_type: entity.entity_type,
        name: entity.name,
        confidence,
        sources: frameIds.length,
        last_compiled: new Date().toISOString(),
        frame_ids: frameIds,
        related_entities: relatedEntities,
      },
      markdown,
      contentHash: contentHash(markdown),
    };
  }

  // ── Concept Page ──────────────────────────────────────────────

  async compileConceptPage(conceptName: string): Promise<WikiPage | null> {
    const searchResults = await this.search.search(conceptName, {
      limit: this.config.maxFramesPerCall,
    });

    const frameData = searchResults.map(r => ({
      id: r.frame.id,
      content: r.frame.content,
      created_at: r.frame.created_at,
    }));

    if (frameData.length < this.config.minFramesPerPage) {
      return null;
    }

    // Find related entities via KG
    const entityResults = this.kg.searchEntities(conceptName, 10);
    const relatedEntities = entityResults.map(e => e.name);

    const prompt = conceptPagePrompt(conceptName, frameData, relatedEntities);
    const body = await this.config.synthesize(prompt);

    const frameIds = frameData.map(f => f.id);
    const confidence = frameData.length > 5 ? 0.85 : 0.6;
    const slug = slugify(conceptName);

    const frontmatter = buildFrontmatter('concept', conceptName, frameIds, relatedEntities, confidence);
    const markdown = `${frontmatter}\n\n# ${conceptName}\n\n${body}`;

    return {
      slug,
      frontmatter: {
        type: 'concept',
        name: conceptName,
        confidence,
        sources: frameIds.length,
        last_compiled: new Date().toISOString(),
        frame_ids: frameIds,
        related_entities: relatedEntities,
      },
      markdown,
      contentHash: contentHash(markdown),
    };
  }

  // ── Synthesis Page ────────────────────────────────────────────

  async compileSynthesisPage(topic: string): Promise<WikiPage | null> {
    const searchResults = await this.search.search(topic, {
      limit: this.config.maxFramesPerCall * 2, // more context for synthesis
    });

    // Group frames by source to detect cross-source patterns
    const bySource = new Map<string, typeof searchResults>();
    for (const r of searchResults) {
      const source = r.frame.source ?? 'unknown';
      let group = bySource.get(source);
      if (!group) {
        group = [];
        bySource.set(source, group);
      }
      group.push(r);
    }

    // Need frames from at least 2 sources for synthesis
    if (bySource.size < 2) {
      return null;
    }

    const crossSourceFrames = searchResults.slice(0, this.config.maxFramesPerCall).map(r => ({
      id: r.frame.id,
      content: r.frame.content,
      source: r.frame.source ?? 'unknown',
      created_at: r.frame.created_at,
    }));

    const prompt = synthesisPagePrompt(topic, crossSourceFrames);
    const body = await this.config.synthesize(prompt);

    const frameIds = crossSourceFrames.map(f => f.id);
    const confidence = bySource.size > 3 ? 0.85 : 0.65;
    const slug = `synthesis-${slugify(topic)}`;
    const sources = Array.from(bySource.keys());

    const frontmatter = buildFrontmatter('synthesis', `Synthesis: ${topic}`, frameIds, sources, confidence);
    const markdown = `${frontmatter}\n\n# Synthesis: ${topic}\n\n${body}`;

    return {
      slug,
      frontmatter: {
        type: 'synthesis',
        name: `Synthesis: ${topic}`,
        confidence,
        sources: frameIds.length,
        last_compiled: new Date().toISOString(),
        frame_ids: frameIds,
        related_entities: sources,
      },
      markdown,
      contentHash: contentHash(markdown),
    };
  }

  // ── Index Page ────────────────────────────────────────────────

  compileIndex(): WikiPage {
    const allPages = this.state.getAllPages();

    const entityPages = allPages.filter(p => p.pageType === 'entity');
    const conceptPages = allPages.filter(p => p.pageType === 'concept');
    const synthesisPages = allPages.filter(p => p.pageType === 'synthesis');

    const lines: string[] = [
      '# Wiki Index',
      '',
      `*${allPages.length} pages compiled — last updated ${new Date().toISOString().slice(0, 10)}*`,
      '',
    ];

    if (entityPages.length > 0) {
      lines.push('## Entities', '');
      for (const p of entityPages) {
        lines.push(`- [[${p.name}]] — ${p.sourceCount} sources (${p.compiledAt.slice(0, 10)})`);
      }
      lines.push('');
    }

    if (conceptPages.length > 0) {
      lines.push('## Concepts', '');
      for (const p of conceptPages) {
        lines.push(`- [[${p.name}]] — ${p.sourceCount} sources (${p.compiledAt.slice(0, 10)})`);
      }
      lines.push('');
    }

    if (synthesisPages.length > 0) {
      lines.push('## Cross-Source Synthesis', '');
      for (const p of synthesisPages) {
        lines.push(`- [[${p.name}]] — ${p.sourceCount} sources (${p.compiledAt.slice(0, 10)})`);
      }
      lines.push('');
    }

    const markdown = lines.join('\n');

    return {
      slug: 'index',
      frontmatter: {
        type: 'index',
        name: 'Wiki Index',
        confidence: 1.0,
        sources: allPages.length,
        last_compiled: new Date().toISOString(),
        frame_ids: [],
        related_entities: [],
      },
      markdown,
      contentHash: contentHash(markdown),
    };
  }

  // ── Health Report ─────────────────────────────────────────────

  compileHealth(): HealthReport {
    const issues: HealthIssue[] = [];
    const allPages = this.state.getAllPages();
    const entityCount = this.kg.getEntityCount();
    const frameStats = this.frames.getStats();

    // Check for orphan entities (KG entities with no wiki page)
    const entities = this.kg.getEntities(1000);
    const pageNames = new Set(allPages.map(p => p.name.toLowerCase()));

    for (const entity of entities) {
      if (!pageNames.has(entity.name.toLowerCase())) {
        // Check if entity has enough frames to justify a page
        const rels = this.kg.getRelationsFrom(entity.id);
        if (rels.length > 0 || entity.entity_type === 'person' || entity.entity_type === 'project') {
          issues.push({
            type: 'missing_page',
            severity: rels.length > 2 ? 'high' : 'medium',
            description: `Entity "${entity.name}" (${entity.entity_type}) has no wiki page`,
            entity: entity.name,
            suggestion: `Run: compileEntityPage("${entity.name}")`,
          });
        }
      }
    }

    // Check for weak pages (few sources)
    for (const page of allPages) {
      if (page.sourceCount < 2 && page.pageType !== 'index') {
        issues.push({
          type: 'weak_confidence',
          severity: 'low',
          description: `Page "${page.name}" has only ${page.sourceCount} source(s)`,
          entity: page.name,
          suggestion: 'Gather more data about this topic',
        });
      }
    }

    // Check for orphan entities in KG (no relations at all)
    for (const entity of entities) {
      const outRels = this.kg.getRelationsFrom(entity.id);
      const inRels = this.kg.getRelationsTo(entity.id);
      if (outRels.length === 0 && inRels.length === 0) {
        issues.push({
          type: 'orphan_entity',
          severity: 'low',
          description: `Entity "${entity.name}" (${entity.entity_type}) has no relations`,
          entity: entity.name,
          suggestion: 'Consider adding relations or retiring this entity',
        });
      }
    }

    // Data quality score
    const hasEntities = entityCount > 0 ? 20 : 0;
    const hasFrames = frameStats.total > 10 ? 20 : frameStats.total > 0 ? 10 : 0;
    const hasPages = allPages.length > 5 ? 20 : allPages.length > 0 ? 10 : 0;
    const lowIssues = issues.filter(i => i.severity === 'high').length;
    const issueDeduction = Math.min(40, lowIssues * 10);
    const dataQualityScore = Math.max(0, hasEntities + hasFrames + hasPages + 40 - issueDeduction);

    return {
      totalEntities: entityCount,
      totalFrames: frameStats.total,
      totalPages: allPages.length,
      issues,
      dataQualityScore,
      compiledAt: new Date().toISOString(),
    };
  }

  // ── Full Compilation ──────────────────────────────────────────

  async compile(options?: { incremental?: boolean; concepts?: string[] }): Promise<CompilationResult> {
    const startTime = Date.now();
    const incremental = options?.incremental ?? true;
    const watermark = this.state.getWatermark();

    let pagesCreated = 0;
    let pagesUpdated = 0;
    let pagesUnchanged = 0;
    const entityPageNames: string[] = [];
    const conceptPageNames: string[] = [];
    const synthesisPageNames: string[] = [];

    // 1. Compile entity pages for all significant entities
    const entities = this.kg.getEntities(200);
    for (const entity of entities) {
      // Skip entities we've already compiled unless new frames exist
      if (incremental && watermark.lastFrameId > 0) {
        const existingPage = this.state.getPage(slugify(entity.name));
        if (existingPage) {
          // Check if new frames mention this entity
          const newFrames = this.state.getFramesSince(watermark.lastFrameId, 100);
          const mentionsEntity = newFrames.some(f =>
            f.content.toLowerCase().includes(entity.name.toLowerCase()),
          );
          if (!mentionsEntity) {
            pagesUnchanged++;
            continue;
          }
        }
      }

      const page = await this.compileEntityPage(entity);
      if (page) {
        const result = this.state.upsertPage(
          page.slug, 'entity', entity.name,
          page.contentHash, page.frontmatter.frame_ids, page.frontmatter.sources,
          page.markdown,
        );
        if (result.action === 'created') pagesCreated++;
        else if (result.action === 'updated') pagesUpdated++;
        else pagesUnchanged++;
        entityPageNames.push(entity.name);
      }
    }

    // 2. Compile concept pages (user-specified or auto-detected)
    const concepts = options?.concepts ?? this.detectConcepts(entities);
    for (const concept of concepts) {
      const page = await this.compileConceptPage(concept);
      if (page) {
        const result = this.state.upsertPage(
          page.slug, 'concept', concept,
          page.contentHash, page.frontmatter.frame_ids, page.frontmatter.sources,
          page.markdown,
        );
        if (result.action === 'created') pagesCreated++;
        else if (result.action === 'updated') pagesUpdated++;
        else pagesUnchanged++;
        conceptPageNames.push(concept);
      }
    }

    // 3. Compile synthesis pages for topics with cross-source data
    for (const concept of concepts) {
      const page = await this.compileSynthesisPage(concept);
      if (page) {
        const result = this.state.upsertPage(
          page.slug, 'synthesis', `Synthesis: ${concept}`,
          page.contentHash, page.frontmatter.frame_ids, page.frontmatter.sources,
          page.markdown,
        );
        if (result.action === 'created') pagesCreated++;
        else if (result.action === 'updated') pagesUpdated++;
        else pagesUnchanged++;
        synthesisPageNames.push(concept);
      }
    }

    // 4. Compile index
    const indexPage = this.compileIndex();
    this.state.upsertPage('index', 'index', 'Wiki Index', indexPage.contentHash, [], 0, indexPage.markdown);

    // 5. Update watermark
    const maxFrameId = this.state.getMaxFrameId();
    const totalCompiled = pagesCreated + pagesUpdated;
    this.state.updateWatermark(maxFrameId, totalCompiled);

    // 6. Health check
    const health = this.compileHealth();

    return {
      pagesCreated,
      pagesUpdated,
      pagesUnchanged,
      entityPages: entityPageNames,
      conceptPages: conceptPageNames,
      synthesisPages: synthesisPageNames,
      healthIssues: health.issues.length,
      watermark: { lastFrameId: maxFrameId, lastCompiledAt: new Date().toISOString(), pagesCompiled: totalCompiled },
      durationMs: Date.now() - startTime,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────

  /** Auto-detect concepts from entity types and common topics. */
  private detectConcepts(entities: Entity[]): string[] {
    const typeCounts = new Map<string, number>();
    for (const e of entities) {
      typeCounts.set(e.entity_type, (typeCounts.get(e.entity_type) ?? 0) + 1);
    }

    const concepts: string[] = [];

    // Add entity types that have multiple entries as concepts
    for (const [type, count] of typeCounts) {
      if (count >= 3 && type !== 'concept') {
        concepts.push(type);
      }
    }

    // Add 'concept' type entities directly as concepts
    const conceptEntities = entities.filter(e => e.entity_type === 'concept');
    for (const e of conceptEntities) {
      if (!concepts.includes(e.name)) {
        concepts.push(e.name);
      }
    }

    return concepts.slice(0, 20); // Cap at 20 concepts
  }

  /**
   * Export all wiki pages as a flat markdown bundle.
   * Returns a map of slug → markdown content, suitable for writing to disk.
   */
  exportToMarkdown(): Map<string, string> {
    const pages = this.state.getAllPages();
    const result = new Map<string, string>();
    for (const page of pages) {
      result.set(page.slug, page.markdown || `# ${page.name}\n\n(no content compiled yet)`);
    }
    return result;
  }

  /**
   * Export all wiki pages to a directory as individual .md files.
   * Creates the directory if it doesn't exist.
   */
  async exportToDirectory(dir: string): Promise<{ filesWritten: number }> {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    const pages = this.exportToMarkdown();
    let count = 0;
    for (const [slug, markdown] of pages) {
      writeFileSync(`${dir}/${slug}.md`, markdown, 'utf-8');
      count++;
    }
    return { filesWritten: count };
  }
}

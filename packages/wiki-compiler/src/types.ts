/**
 * Wiki Compiler Types — page definitions, compilation config, and state tracking.
 */

// ── Page Types ──────────────────────────────────────────────────

export type WikiPageType =
  | 'entity'
  | 'concept'
  | 'synthesis'
  | 'index'
  | 'health';

export interface WikiPageFrontmatter {
  type: WikiPageType;
  name: string;
  entity_type?: string;
  confidence: number;
  sources: number;
  last_compiled: string;
  frame_ids: number[];
  related_entities: string[];
}

export interface WikiPage {
  /** URL-safe slug, e.g. "project-alpha" */
  slug: string;
  /** Page frontmatter */
  frontmatter: WikiPageFrontmatter;
  /** Full markdown content (including frontmatter as YAML) */
  markdown: string;
  /** SHA-256 hash of content for change detection */
  contentHash: string;
}

// ── Compilation State ───────────────────────────────────────────

export interface CompilationWatermark {
  /** Highest frame ID processed in last compilation */
  lastFrameId: number;
  /** ISO timestamp of last compilation */
  lastCompiledAt: string;
  /** Number of pages generated/updated */
  pagesCompiled: number;
}

export interface PageRecord {
  slug: string;
  pageType: WikiPageType;
  name: string;
  contentHash: string;
  markdown: string;
  frameIds: string; // JSON array
  compiledAt: string;
  sourceCount: number;
}

// ── Compiler Configuration ──────────────────────────────────────

export type LLMSynthesizeFn = (prompt: string) => Promise<string>;

export interface CompilerConfig {
  /** Function to call the LLM for synthesis */
  synthesize: LLMSynthesizeFn;
  /** Output directory for wiki pages (default: wiki/) */
  outputDir?: string;
  /** Minimum frames to justify a page (default: 2) */
  minFramesPerPage?: number;
  /** Maximum frames to send as context per LLM call (default: 30) */
  maxFramesPerCall?: number;
  /** Minimum confidence for entity pages (default: 0.3) */
  minConfidence?: number;
}

// ── Compilation Result ──────────────────────────────────────────

export interface CompilationResult {
  pagesCreated: number;
  pagesUpdated: number;
  pagesUnchanged: number;
  entityPages: string[];
  conceptPages: string[];
  synthesisPages: string[];
  healthIssues: number;
  watermark: CompilationWatermark;
  durationMs: number;
}

// ── Health Report ───────────────────────────────────────────────

export type HealthIssueType =
  | 'contradiction'
  | 'gap'
  | 'orphan_entity'
  | 'weak_confidence'
  | 'stale_page'
  | 'missing_page';

export interface HealthIssue {
  type: HealthIssueType;
  severity: 'high' | 'medium' | 'low';
  description: string;
  entity?: string;
  frameIds?: number[];
  suggestion?: string;
}

export interface HealthReport {
  totalEntities: number;
  totalFrames: number;
  totalPages: number;
  issues: HealthIssue[];
  dataQualityScore: number; // 0-100
  compiledAt: string;
}

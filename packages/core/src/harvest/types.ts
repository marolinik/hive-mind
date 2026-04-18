/**
 * Harvest types — universal import format and distillation pipeline types.
 *
 * Every adapter (chatgpt, claude, gemini, pdf, url, etc.) parses its
 * source-specific input into `UniversalImportItem[]`. The pipeline then
 * flows `UniversalImportItem` → classification → extraction → synthesis,
 * ending in `DistilledKnowledge[]` that the memory substrate (frames,
 * KG, identity) can persist.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/types.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

// ── Source types ────────────────────────────────────────────────────────

export type ImportSourceType =
  | 'chatgpt'
  | 'claude'
  | 'claude-code'
  | 'claude-desktop'
  | 'gemini'
  | 'google-ai-studio'
  | 'perplexity'
  | 'grok'
  | 'cursor'
  | 'copilot'
  | 'manus'
  | 'genspark'
  | 'qwen'
  | 'minimax'
  | 'z-ai'
  | 'openclaw'
  | 'cowork'
  | 'elevenlabs'
  | 'google-flow'
  | 'markdown'
  | 'plaintext'
  | 'pdf'
  | 'url'
  | 'unknown';

export type ImportItemType =
  | 'conversation'
  | 'memory'
  | 'instruction'
  | 'preference'
  | 'artifact'
  | 'rule'
  | 'decision'
  | 'document';

// ── Universal import item (adapter output) ──────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp?: string;
}

export interface UniversalImportItem {
  id: string;
  source: ImportSourceType;
  type: ImportItemType;
  title: string;
  content: string;
  messages?: ConversationMessage[];
  timestamp: string;
  metadata: Record<string, unknown>;
}

// ── Distilled knowledge (pipeline output) ───────────────────────────────

export type DistillTargetLayer = 'identity' | 'frame' | 'kg_entity' | 'kg_relation' | 'awareness';

export interface KnowledgeProvenance {
  originalSource: ImportSourceType;
  originalId?: string;
  conversationTitle?: string;
  importedAt: string;
  distillationModel: string;
  confidence: number;
  pass: number;
}

export interface DistilledKnowledge {
  targetLayer: DistillTargetLayer;
  frameType?: 'I' | 'P';
  importance: 'critical' | 'important' | 'normal' | 'temporary';
  content: string;
  entities?: { name: string; type: string }[];
  relations?: { source: string; target: string; relation: string }[];
  provenance: KnowledgeProvenance;
}

// ── Classification (Pass 1 output) ──────────────────────────────────────

export type ClassificationDomain = 'work' | 'personal' | 'technical' | 'mixed';
export type ClassificationValue = 'high' | 'medium' | 'low' | 'skip';

export interface ClassifiedItem {
  item: UniversalImportItem;
  domain: ClassificationDomain;
  value: ClassificationValue;
  categories: string[];
}

// ── Extraction (Pass 2 output) ──────────────────────────────────────────

export interface ExtractedContent {
  itemId: string;
  decisions: string[];
  preferences: string[];
  facts: string[];
  knowledge: string[];
  entities: { name: string; type: string }[];
  relations: { source: string; target: string; relation: string }[];
}

// ── Pipeline result ─────────────────────────────────────────────────────

export interface HarvestPipelineResult {
  source: ImportSourceType;
  itemsReceived: number;
  itemsClassified: number;
  itemsSkipped: number;
  itemsExtracted: number;
  knowledgeDistilled: DistilledKnowledge[];
  framesSaved: number;
  entitiesCreated: number;
  relationsCreated: number;
  identityUpdates: number;
  duplicatesSkipped: number;
  errors: string[];
  costUsd: number;
  durationMs: number;
}

// ── Harvest source (tracking table) ─────────────────────────────────────

export interface HarvestSource {
  id: number;
  source: ImportSourceType;
  displayName: string;
  sourcePath: string | null;
  lastSyncedAt: string | null;
  itemsImported: number;
  framesCreated: number;
  autoSync: boolean;
  syncIntervalHours: number;
  lastContentHash: string | null;
  createdAt: string;
}

// ── Adapter interface ───────────────────────────────────────────────────

export interface SourceAdapter {
  readonly sourceType: ImportSourceType;
  readonly displayName: string;
  parse(input: unknown): UniversalImportItem[];
}

export interface FilesystemAdapter extends SourceAdapter {
  scan(dirPath: string): UniversalImportItem[];
}

/**
 * HarvestPipeline — orchestrates the 4-pass distillation pipeline.
 *
 * Pass 0: Injection scan (local — no LLM)
 * Pass 1: Classify (fast model — cheap)
 * Pass 2: Extract (accurate model)
 * Pass 3: Synthesize (accurate model)
 * Pass 4: Dedup (local — no LLM)
 *
 * The pipeline accepts UniversalImportItems and produces DistilledKnowledge[].
 * LLM calls are batched (default 20 items per call) and run with a concurrency
 * cap (default 3) to balance cost and latency.
 */

import type {
  UniversalImportItem, ClassifiedItem, ExtractedContent,
  DistilledKnowledge, HarvestPipelineResult, ImportSourceType,
} from './types.js';
import { CLASSIFY_PROMPT, EXTRACT_PROMPT, SYNTHESIZE_PROMPT } from './prompts.js';
import { dedup } from './dedup.js';
import { scanForInjection } from '../injection-scanner.js';
import { createCoreLogger } from '../logger.js';

const log = createCoreLogger('harvest-pipeline');

const BATCH_SIZE = 20;
const CONCURRENCY_CAP = 3;

export interface LLMCallFn {
  (prompt: string, model: 'fast' | 'accurate'): Promise<string>;
}

export interface PipelineOptions {
  llmCall: LLMCallFn;
  existingContents?: string[];
  onProgress?: (stage: string, current: number, total: number) => void;
  /** Items per LLM batch call (default: 20). */
  batchSize?: number;
  /** Max concurrent LLM batch calls (default: 3). */
  concurrency?: number;
  /**
   * Fallback behavior when the Pass 1 (classify) LLM call throws.
   * - `'skip'` (default, safer): drop the batch. Under-inclusion beats cost/noise inflation.
   * - `'pass-through-medium'` (legacy): promote every item to `value: 'medium'`. This is what
   *   the pipeline did historically but it runs extract + synthesize on junk and pollutes
   *   memory with trivial greetings/debugging loops when the classify model hiccups.
   */
  classifyFailureFallback?: 'skip' | 'pass-through-medium';
}

/** Safely parse JSON from LLM response, handling markdown code fences. */
function parseLLMJson<T>(raw: string): T[] {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Split array into batches. */
function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/** Run async tasks with a concurrency cap (tumbling window — waits for full batch before next). */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  cap: number,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += cap) {
    const window = tasks.slice(i, i + cap);
    const windowResults = await Promise.all(window.map(fn => fn()));
    results.push(...windowResults);
  }
  return results;
}

export class HarvestPipeline {
  private llmCall: LLMCallFn;
  private existingContents: string[];
  private onProgress?: (stage: string, current: number, total: number) => void;
  private classifyFailureFallback: 'skip' | 'pass-through-medium';
  private batchSize: number;
  private concurrency: number;

  constructor(options: PipelineOptions) {
    this.llmCall = options.llmCall;
    this.existingContents = options.existingContents ?? [];
    this.onProgress = options.onProgress;
    this.classifyFailureFallback = options.classifyFailureFallback ?? 'skip';
    this.batchSize = options.batchSize ?? BATCH_SIZE;
    this.concurrency = options.concurrency ?? CONCURRENCY_CAP;
  }

  async run(items: UniversalImportItem[], source: ImportSourceType): Promise<HarvestPipelineResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    log.info('harvest pipeline starting', { source, itemCount: items.length, batchSize: this.batchSize, concurrency: this.concurrency });

    // Pass 0: Injection scan — drop any item whose title or content carries a
    // prompt-injection payload (role_override / prompt_extraction / instruction_injection).
    // Harvest ingests UNTRUSTED external exports (ChatGPT/Claude/Gemini JSON dumps,
    // Perplexity shares, URL fetches). A hostile file must not flow through to the
    // LLM passes or into memory frames.
    const originalCount = items.length;
    items = items.filter((item) => {
      // Scan title + first 4KB of content — enough to catch payloads hidden in either field.
      // Using 'tool_output' context since imports are external data, weighted like tool output.
      const probe = `${item.title ?? ''}\n${(item.content ?? '').slice(0, 4000)}`;
      const scan = scanForInjection(probe, 'tool_output');
      if (!scan.safe) {
        const reason = scan.flags.join(',');
        log.warn('dropping harvest item with injection payload', {
          itemId: item.id,
          title: item.title?.slice(0, 80),
          flags: scan.flags,
          score: scan.score,
        });
        errors.push(`Blocked item "${item.title?.slice(0, 40) ?? item.id}" — injection detected (${reason})`);
        return false;
      }
      return true;
    });
    const blockedCount = originalCount - items.length;
    if (blockedCount > 0) {
      log.info(`harvest security: blocked ${blockedCount} of ${originalCount} items for injection patterns`);
    }

    // Pass 1: Classify
    this.onProgress?.('classify', 0, items.length);
    const classified = await this.classify(items, errors);
    const valuable = classified.filter(c => c.value !== 'skip');

    // Pass 2: Extract
    this.onProgress?.('extract', 0, valuable.length);
    const extracted = await this.extract(valuable, errors);

    // Pass 3: Synthesize
    this.onProgress?.('synthesize', 0, extracted.length);
    const distilled = await this.synthesize(extracted, source, errors);

    // Pass 4: Dedup
    this.onProgress?.('dedup', 0, distilled.length);
    const dedupResult = dedup(distilled, this.existingContents);

    const durationMs = Date.now() - startTime;
    log.info('harvest pipeline complete', {
      source, itemsReceived: originalCount, classified: classified.length,
      extracted: extracted.length, distilled: distilled.length,
      unique: dedupResult.unique.length, dupsSkipped: dedupResult.duplicatesSkipped,
      errors: errors.length, durationMs,
    });

    return {
      source, itemsReceived: originalCount,
      itemsClassified: classified.length,
      itemsSkipped: classified.length - valuable.length,
      itemsExtracted: extracted.length,
      knowledgeDistilled: dedupResult.unique,
      framesSaved: 0, // Caller handles persistence
      entitiesCreated: 0,
      relationsCreated: 0,
      identityUpdates: dedupResult.unique.filter(k => k.targetLayer === 'identity').length,
      duplicatesSkipped: dedupResult.duplicatesSkipped,
      errors,
      costUsd: 0, // Caller tracks cost
      durationMs,
    };
  }

  private async classify(items: UniversalImportItem[], errors: string[]): Promise<ClassifiedItem[]> {
    const results: ClassifiedItem[] = [];
    const batches = batch(items, this.batchSize);

    const tasks = batches.map((b, i) => async () => {
      this.onProgress?.('classify', i * this.batchSize, items.length);
      const prompt = CLASSIFY_PROMPT + b.map((item, idx) => (
        `\n--- Item ${idx} (id: ${item.id}) ---\nTitle: ${item.title}\nSource: ${item.source}\nType: ${item.type}\nContent (first 500 chars): ${item.content.slice(0, 500)}\n`
      )).join('');

      try {
        const response = await this.llmCall(prompt, 'fast');
        const parsed = parseLLMJson<{ itemId?: string; domain?: string; value?: string; categories?: string[] }>(response);
        const batchResults: ClassifiedItem[] = [];

        for (const entry of parsed) {
          if (!entry.itemId) {
            log.warn('classify entry missing itemId — skipping', { batchIndex: i });
            continue;
          }
          const item = b.find(it => it.id === entry.itemId);
          if (!item) {
            log.warn('classify entry itemId does not match any batch item — skipping', { itemId: entry.itemId, batchIndex: i });
            continue;
          }
          batchResults.push({
            item,
            domain: (entry.domain as ClassifiedItem['domain']) ?? 'mixed',
            value: (entry.value as ClassifiedItem['value']) ?? 'medium',
            categories: entry.categories ?? [],
          });
        }
        return batchResults;
      } catch (err) {
        errors.push(`Classify batch ${i} failed: ${err instanceof Error ? err.message : 'unknown'}`);
        if (this.classifyFailureFallback === 'pass-through-medium') {
          return b.map(item => ({ item, domain: 'mixed' as const, value: 'medium' as const, categories: [] as string[] }));
        }
        return [] as ClassifiedItem[];
      }
    });

    const batchResults = await runWithConcurrency(tasks, this.concurrency);
    for (const br of batchResults) results.push(...br);

    return results;
  }

  private async extract(classified: ClassifiedItem[], errors: string[]): Promise<ExtractedContent[]> {
    const results: ExtractedContent[] = [];
    const batches = batch(classified, this.batchSize);

    const tasks = batches.map((b, i) => async () => {
      this.onProgress?.('extract', i * this.batchSize, classified.length);
      const prompt = EXTRACT_PROMPT + b.map((c, idx) => (
        `\n--- Conversation ${idx} (id: ${c.item.id}, value: ${c.value}, categories: ${c.categories.join(',')}) ---\nTitle: ${c.item.title}\n${c.item.content.slice(0, 2000)}\n`
      )).join('');

      try {
        const response = await this.llmCall(prompt, 'accurate');
        const parsed = parseLLMJson<{
          itemId?: string;
          decisions?: unknown[]; preferences?: unknown[]; facts?: unknown[];
          knowledge?: unknown[]; entities?: unknown[]; relations?: unknown[];
        }>(response);
        const batchResults: ExtractedContent[] = [];

        for (const entry of parsed) {
          if (!entry.itemId) {
            log.warn('extract entry missing itemId — skipping', { batchIndex: i });
            continue;
          }
          if (!b.some(c => c.item.id === entry.itemId)) {
            log.warn('extract entry itemId does not match batch — skipping', { itemId: entry.itemId, batchIndex: i });
            continue;
          }
          batchResults.push({
            itemId: entry.itemId,
            decisions: (entry.decisions ?? []) as ExtractedContent['decisions'],
            preferences: (entry.preferences ?? []) as ExtractedContent['preferences'],
            facts: (entry.facts ?? []) as ExtractedContent['facts'],
            knowledge: (entry.knowledge ?? []) as ExtractedContent['knowledge'],
            entities: (entry.entities ?? []) as ExtractedContent['entities'],
            relations: (entry.relations ?? []) as ExtractedContent['relations'],
          });
        }
        return batchResults;
      } catch (err) {
        errors.push(`Extract batch ${i} failed: ${err instanceof Error ? err.message : 'unknown'}`);
        return [] as ExtractedContent[];
      }
    });

    const batchResults = await runWithConcurrency(tasks, this.concurrency);
    for (const br of batchResults) results.push(...br);

    return results;
  }

  private async synthesize(
    extracted: ExtractedContent[],
    source: ImportSourceType,
    errors: string[],
  ): Promise<DistilledKnowledge[]> {
    const results: DistilledKnowledge[] = [];
    const batches = batch(extracted, this.batchSize);

    // Per-item serialization with individual budget. The previous flat
    // `JSON.stringify(b, null, 2).slice(0, 8000)` truncated the middle of the last
    // item's JSON on a long batch; parseLLMJson returned [] on the malformed tail and
    // every subsequent item silently vanished with no error. Now each item gets its
    // own PER_ITEM_BUDGET and survives regardless of batch size.
    const PER_ITEM_BUDGET = 1200;

    const tasks = batches.map((b, i) => async () => {
      this.onProgress?.('synthesize', i * this.batchSize, extracted.length);
      const serialized = b.map((ec, idx) => {
        const json = JSON.stringify(ec, null, 2);
        const trimmed = json.length > PER_ITEM_BUDGET
          ? json.slice(0, PER_ITEM_BUDGET) + '\n  ... (truncated — full item in trace)'
          : json;
        return `\n--- Item ${idx} (id: ${ec.itemId}) ---\n${trimmed}`;
      }).join('');
      const prompt = SYNTHESIZE_PROMPT + serialized;

      try {
        const response = await this.llmCall(prompt, 'accurate');
        const parsed = parseLLMJson<{
          targetLayer?: string; frameType?: string; importance?: string;
          content?: string; confidence?: number;
        }>(response);
        const batchResults: DistilledKnowledge[] = [];

        for (const entry of parsed) {
          batchResults.push({
            targetLayer: (entry.targetLayer as DistilledKnowledge['targetLayer']) ?? 'frame',
            frameType: (entry.frameType as DistilledKnowledge['frameType']) ?? 'I',
            importance: (entry.importance as DistilledKnowledge['importance']) ?? 'normal',
            content: entry.content ?? '',
            provenance: {
              originalSource: source,
              importedAt: new Date().toISOString(),
              distillationModel: 'accurate',
              confidence: entry.confidence ?? 0.7,
              pass: 3,
            },
          });
        }
        return batchResults;
      } catch (err) {
        errors.push(`Synthesize batch ${i} failed: ${err instanceof Error ? err.message : 'unknown'}`);
        return [] as DistilledKnowledge[];
      }
    });

    const batchResults = await runWithConcurrency(tasks, this.concurrency);
    for (const br of batchResults) results.push(...br);

    return results;
  }
}

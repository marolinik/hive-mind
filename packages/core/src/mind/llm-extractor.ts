/**
 * LLM-based entity extraction for cognify (Phase 3b-2).
 *
 * The heuristic regex-based extractor in cognify.ts produces high noise
 * because capitalized n-grams catch sentence-starts, log prefixes, and
 * fragments. This module replaces the regex with an LLM pass that
 * understands semantics and returns typed entities (person, project,
 * file, decision, bug).
 *
 * Two executor paths share the same prompt/parser so the result quality
 * is identical regardless of how the model is invoked:
 *   - 'cc'  spawns `claude -p --output-format=text` (zero API key, uses
 *           the user's CC subscription). Sets HIVE_MIND_NO_SYNTH=1 so
 *           the spawned CC's Stop hook does not enqueue a successor
 *           synth task — matches the established pattern from
 *           hive-mind-test/packages/enrichment/bin/synth-drain.js.
 *   - 'api' POSTs to Anthropic Messages API (requires ANTHROPIC_API_KEY).
 *           OSS-only path; Marko's stack is exclusively 'cc'.
 *
 * Batching is mandatory for throughput. Per-frame spawn would take
 * ~3-10s × N frames; a 5-frame batch costs the same per-call but covers
 * 5× more content. The prompt asks the model to key its JSONL output
 * by the input's frame_id so a partial response still attributes
 * entities to the right frames.
 */

import { spawn } from 'node:child_process';
import { isNoiseName } from './entity-normalizer.js';

/** Canonical entity types the prompt asks the model to choose from. */
export const LLM_ENTITY_TYPES = [
  'person',
  'project',
  'file',
  'decision',
  'bug',
  'concept',
  'tool',
  'location',
] as const;

export type LlmEntityType = (typeof LLM_ENTITY_TYPES)[number];

/** One extracted entity attributed back to its source frame. */
export interface ExtractedEntity {
  frame_id: number;
  name: string;
  type: LlmEntityType;
  /** Optional model-reported mention count within the frame. */
  mentions?: number;
}

export type LlmExecutor = 'cc' | 'api';

export interface LlmExtractorOptions {
  /** 'cc' (default) for claude -p subprocess, 'api' for Anthropic API. */
  executor?: LlmExecutor;
  /**
   * Frames per batch. Larger = fewer subprocess spawns but bigger prompts
   * and a worse failure radius (one bad parse loses N frames of work).
   * Default 3 — early backfill runs found that batch=5 with raw frames
   * pushed claude -p past 90s on long content (timeouts dropped 28% of
   * batches). Smaller batches paired with content caps fit comfortably.
   */
  batchSize?: number;
  /** Anthropic model id when executor='api'. Default haiku for batch cost. */
  model?: string;
  /** Cap individual subprocess wall-clock so a hung CC doesn't block forever. */
  timeoutMs?: number;
  /**
   * Per-frame content cap before sending to the model. Long wiki-synth
   * frames can exceed 8KB; sending raw blew past CC's response time
   * budget and triggered timeouts. Entity extraction does not need the
   * full frame — the first ~2-3KB carries the named entities. Default
   * 2500 chars; pass 0 to disable truncation.
   */
  maxFrameChars?: number;
  /**
   * Optional callback fired after each batch — useful for the cognify CLI
   * to show progress on a long backfill without waiting for the full result.
   */
  onBatchComplete?: (info: { batchIndex: number; entitiesFound: number; framesProcessed: number }) => void;
}

interface FrameInput {
  id: number;
  content: string;
}

const DEFAULT_BATCH_SIZE = 3;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_FRAME_CHARS = 2500;

/** The instructions block sent to the model. Stable across batches. */
const PROMPT_INSTRUCTIONS = `Extract named entities from the FRAMES below. For each entity, output ONE JSON object on its own line.

OUTPUT FORMAT (JSONL — one object per line, no other text):
{"frame_id": <number>, "name": "<entity name>", "type": "<type>", "mentions": <int>}

VALID TYPES (pick the closest fit):
- person       a specific human (e.g. "Marko", "Alice Chen")
- project      a named project, repo, codebase, or product (e.g. "hive-mind", "Phase 3")
- file         a specific file path or filename (e.g. "synth-drain.js", "PHASE-3-PLAN.md")
- decision     a specific architectural or strategic choice with a name (e.g. "open-core boundary")
- bug          a known issue, incident, or failure mode (e.g. "subprocess feedback loop")
- tool         a CLI tool, library, framework, or service (e.g. "Ollama", "Voyage", "sqlite-vec")
- concept      a domain concept that doesn't fit above (e.g. "watermark", "reranker")
- location     a directory or workspace path (e.g. "D:/Projects/hive-mind")

DO NOT EXTRACT:
- pronouns, demonstratives ("this", "that", "these")
- generic verbs at sentence start ("Add", "Update", "Run")
- standalone acronyms shorter than 4 chars ("API", "CLI", "MCP", "JSON")
- weekdays, months, dates
- common English words
- fragments — if you'd struggle to write a wiki page about it, skip it

QUALITY BAR: ~3-8 high-signal entities per frame is typical. If a frame is short or non-substantive, return zero entities for it (just don't emit lines for it).

Output JSONL only. No prose, no markdown fences, no commentary.`;

/** Builds the user-message text for one batch. */
function buildBatchPrompt(frames: FrameInput[], maxFrameChars: number): string {
  const sep = '='.repeat(60);
  const blocks = frames.map((f) => {
    const trimmed = f.content.trim();
    const body = maxFrameChars > 0 && trimmed.length > maxFrameChars
      ? `${trimmed.slice(0, maxFrameChars)}\n[...frame truncated for extraction; ${trimmed.length - maxFrameChars} chars omitted]`
      : trimmed;
    return `${sep}\nFRAME id=${f.id}\n${sep}\n${body}`;
  }).join('\n\n');
  return `${PROMPT_INSTRUCTIONS}\n\n${blocks}\n\n=== END OF FRAMES ===\n\nNow output JSONL:`;
}

/**
 * Strips fenced code blocks the model sometimes adds despite instructions.
 * Returns the inner content if a single ```...``` block wraps everything,
 * else the original text.
 */
function unwrapFencedBlock(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json|jsonl)?\s*\n([\s\S]*?)\n```\s*$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

/**
 * Parses LLM output into typed entities. Per-line try/catch: a single
 * malformed line never aborts the whole batch. Lines without a valid
 * frame_id (i.e. the model invented one) are dropped — the caller can't
 * attribute them, so they're worse than missing.
 */
function parseJsonlOutput(raw: string, validFrameIds: Set<number>): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const cleaned = unwrapFencedBlock(raw);

  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const frameId = Number(parsed.frame_id);
    if (!Number.isFinite(frameId) || !validFrameIds.has(frameId)) continue;

    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    if (name.length < 2) continue;
    // Write-time noise filter: drop low-signal names (stop tokens, acronyms,
    // sub-4-char non-allowlisted) so the LLM path can't leak noise into the
    // graph the way the soft prompt instruction sometimes did.
    if (isNoiseName(name)) continue;

    const rawType = typeof parsed.type === 'string' ? parsed.type.toLowerCase().trim() : 'concept';
    const type = (LLM_ENTITY_TYPES as readonly string[]).includes(rawType)
      ? (rawType as LlmEntityType)
      : 'concept';

    const mentions = Number(parsed.mentions);
    entities.push({
      frame_id: frameId,
      name,
      type,
      mentions: Number.isFinite(mentions) && mentions > 0 ? mentions : undefined,
    });
  }

  return entities;
}

function callClaudeSubprocess(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--output-format=text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // claude on Windows is a .cmd shim; spawn needs shell:true to find it.
      shell: process.platform === 'win32',
      // HIVE_MIND_NO_SYNTH=1 makes the spawned CC's hooks no-op so its Stop
      // event doesn't enqueue a synth task — same defense the synth-drain uses.
      env: { ...process.env, HIVE_MIND_NO_SYNTH: '1' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`spawn claude failed: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 400)}`));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

interface AnthropicMessageBlock {
  type?: string;
  text?: string;
}

interface AnthropicMessageResponse {
  content?: AnthropicMessageBlock[];
}

async function callAnthropicApi(prompt: string, model: string, timeoutMs: number): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY not set — pass executor='cc' or set the env var");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`anthropic ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = (await res.json()) as AnthropicMessageResponse;
    const text = (data.content ?? []).map((b) => b.text ?? '').join('').trim();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract entities from N frames using an LLM. Internally batches N into
 * groups of `batchSize` and calls the executor once per batch. Per-batch
 * failures are logged to stderr but never abort the whole pass — partial
 * results are always preferable to zero results when one frame in a
 * batch confuses the model.
 */
export async function extractEntitiesViaLLM(
  frames: ReadonlyArray<FrameInput>,
  options: LlmExtractorOptions = {},
): Promise<ExtractedEntity[]> {
  if (frames.length === 0) return [];

  const executor: LlmExecutor = options.executor ?? 'cc';
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFrameChars = options.maxFrameChars ?? DEFAULT_MAX_FRAME_CHARS;

  const all: ExtractedEntity[] = [];
  let batchIndex = 0;
  let framesProcessed = 0;

  for (let i = 0; i < frames.length; i += batchSize) {
    const batch = frames.slice(i, i + batchSize);
    const validIds = new Set(batch.map((f) => f.id));
    const prompt = buildBatchPrompt(batch, maxFrameChars);

    let raw: string;
    try {
      raw = executor === 'cc'
        ? await callClaudeSubprocess(prompt, timeoutMs)
        : await callAnthropicApi(prompt, model, timeoutMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Per-batch failure: skip this batch but keep going. Visible to caller
      // via stderr so a runaway-broken executor surfaces immediately.
      process.stderr.write(`[llm-extract] batch ${batchIndex} failed (frames ${batch[0].id}..${batch[batch.length - 1].id}): ${msg}\n`);
      batchIndex++;
      continue;
    }

    const found = parseJsonlOutput(raw, validIds);
    all.push(...found);
    framesProcessed += batch.length;

    if (options.onBatchComplete) {
      options.onBatchComplete({ batchIndex, entitiesFound: found.length, framesProcessed });
    }
    batchIndex++;
  }

  return all;
}

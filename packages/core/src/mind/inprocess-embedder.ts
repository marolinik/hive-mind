/**
 * In-process embedder using @huggingface/transformers (ONNX Runtime).
 * Zero-config default — runs fully offline after the first model download.
 * Model: Xenova/all-MiniLM-L6-v2 (384 native dims, normalized to target dims).
 * Downloads ~23MB on first use, cached in ~/.hive-mind/models/ by default.
 *
 * The `@huggingface/transformers` package is an **optional** peer dependency.
 * Install it if you want to use this embedder. Without it, createEmbeddingProvider
 * will skip inprocess during probing and fall through to the next available
 * provider (Ollama → Voyage → OpenAI → LiteLLM → Mock).
 *
 * Extracted from Waggle OS `packages/core/src/mind/inprocess-embedder.ts`.
 * Scrub: model cache dir rebrand `~/.waggle/` → `~/.hive-mind/`; logger tag
 * namespace rebrand.
 */

import path from 'node:path';
import os from 'node:os';
import type { Embedder } from './embeddings.js';
import { createCoreLogger } from '../logger.js';

const log = createCoreLogger('inprocess-embedder');

export interface InProcessEmbedderConfig {
  model?: string;
  cacheDir?: string;
  targetDimensions?: number;
}

/** Normalize embedding dimensions: zero-pad shorter, truncate longer. */
export function normalizeDimensions(embedding: Float32Array, targetDims: number): Float32Array {
  if (embedding.length === targetDims) return embedding;
  const result = new Float32Array(targetDims);
  const copyLen = Math.min(embedding.length, targetDims);
  result.set(embedding.subarray(0, copyLen));
  return result;
}

export async function createInProcessEmbedder(config?: Partial<InProcessEmbedderConfig>): Promise<Embedder> {
  const model = config?.model ?? 'Xenova/all-MiniLM-L6-v2';
  const cacheDir = config?.cacheDir ?? path.join(os.homedir(), '.hive-mind', 'models');
  const targetDims = config?.targetDimensions ?? 1024;

  log.info(`Loading in-process embedding model: ${model} (~23MB first download)`);

  // Dynamic import keeps @huggingface/transformers as an optional peer dep.
  // Consumers who do not install it will trip this line and the factory
  // will catch the failure and move to the next provider in the chain.
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  env.allowRemoteModels = true;

  const extractor = await pipeline('feature-extraction', model, { dtype: 'fp32' });
  const nativeDims = 384;

  log.info(`In-process embedder ready (${nativeDims} native dims → ${targetDims} normalized)`);

  return {
    dimensions: targetDims,

    async embed(text: string): Promise<Float32Array> {
      const result = await extractor(text, { pooling: 'mean', normalize: true });
      const raw = new Float32Array(result.data as Float32Array);
      return normalizeDimensions(raw, targetDims);
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const results: Float32Array[] = [];
      for (const text of texts) {
        const result = await extractor(text, { pooling: 'mean', normalize: true });
        const raw = new Float32Array(result.data as Float32Array);
        results.push(normalizeDimensions(raw, targetDims));
      }
      return results;
    },
  };
}

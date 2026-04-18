/**
 * Ollama-backed embedder — calls a local Ollama server's `/api/embed` endpoint.
 * For users who have Ollama installed and want to stay fully local.
 *
 * Extracted from Waggle OS `packages/core/src/mind/ollama-embedder.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import type { Embedder } from './embeddings.js';
import { normalizeDimensions } from './inprocess-embedder.js';

export interface OllamaEmbedderConfig {
  baseUrl?: string;
  model?: string;
  targetDimensions?: number;
}

export function createOllamaEmbedder(config?: Partial<OllamaEmbedderConfig>): Embedder {
  const baseUrl = config?.baseUrl ?? 'http://localhost:11434';
  const model = config?.model ?? 'nomic-embed-text';
  const targetDims = config?.targetDimensions ?? 1024;
  const url = `${baseUrl}/api/embed`;

  async function callOllama(input: string | string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama embeddings error (${response.status}): ${text}`);
      }

      const json = (await response.json()) as { embeddings: number[][] };
      return json.embeddings.map((e) => normalizeDimensions(new Float32Array(e), targetDims));
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    dimensions: targetDims,

    async embed(text: string): Promise<Float32Array> {
      const results = await callOllama(text);
      return results[0];
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      return callOllama(texts);
    },
  };
}

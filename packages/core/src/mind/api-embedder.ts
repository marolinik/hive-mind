/**
 * API-backed embedder — calls Voyage AI or OpenAI embedding endpoints.
 * For users who configure API keys at the application layer and want the
 * quality of a hosted model without running Ollama or a local model.
 *
 * Extracted from Waggle OS `packages/core/src/mind/api-embedder.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import type { Embedder } from './embeddings.js';
import { normalizeDimensions } from './inprocess-embedder.js';

export interface ApiEmbedderConfig {
  provider: 'voyage' | 'openai';
  apiKey: string;
  model?: string;
  targetDimensions?: number;
  baseUrl?: string;
}

const PROVIDER_DEFAULTS: Record<'voyage' | 'openai', { url: string; model: string }> = {
  voyage: { url: 'https://api.voyageai.com/v1/embeddings', model: 'voyage-3-lite' },
  openai: { url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small' },
};

export function createApiEmbedder(config: ApiEmbedderConfig): Embedder {
  const defaults = PROVIDER_DEFAULTS[config.provider];
  const url = config.baseUrl ?? defaults.url;
  const model = config.model ?? defaults.model;
  const targetDims = config.targetDimensions ?? 1024;

  async function callApi(input: string | string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const body: Record<string, unknown> = { model, input };
    if (config.provider === 'voyage') {
      body.input_type = 'document';
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${config.provider} embeddings error (${response.status}): ${text}`);
      }

      const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
      return json.data.map((d) => normalizeDimensions(new Float32Array(d.embedding), targetDims));
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    dimensions: targetDims,

    async embed(text: string): Promise<Float32Array> {
      const results = await callApi(text);
      return results[0];
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      return callApi(texts);
    },
  };
}

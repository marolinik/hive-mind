/**
 * LiteLLM-backed embedder — calls the OpenAI-compatible `/v1/embeddings`
 * endpoint exposed by a LiteLLM proxy server. Useful for routing embeddings
 * through the same gateway as your chat completions.
 *
 * Falls back to a deterministic mock (text→Float32Array hash) on API error
 * when `fallbackToMock` is set — primarily for smoke-testing downstream code
 * paths without provisioning a live LiteLLM instance.
 *
 * Extracted from Waggle OS `packages/core/src/mind/litellm-embedder.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import type { Embedder } from './embeddings.js';

export interface LiteLLMEmbedderConfig {
  litellmUrl: string;
  litellmApiKey?: string;
  model?: string;
  dimensions?: number;
  /** Custom fetch implementation (for testing). */
  fetch?: typeof globalThis.fetch;
  /** If true, falls back to a deterministic mock on API error instead of throwing. */
  fallbackToMock?: boolean;
}

function mockEmbed(text: string, dims: number): Float32Array {
  const arr = new Float32Array(dims);
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < Math.min(bytes.length, dims); i++) {
    arr[i] = (bytes[i] - 128) / 128;
  }
  return arr;
}

export function createLiteLLMEmbedder(config: LiteLLMEmbedderConfig): Embedder {
  const {
    litellmUrl,
    litellmApiKey,
    model = 'text-embedding',
    dimensions = 1024,
    fetch: fetchFn = globalThis.fetch,
    fallbackToMock = false,
  } = config;

  // Strip trailing /v1 if the caller passed one — we add it ourselves.
  const baseUrl = litellmUrl.replace(/\/v1\/?$/, '');
  const url = `${baseUrl}/v1/embeddings`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (litellmApiKey) {
    headers['Authorization'] = `Bearer ${litellmApiKey}`;
  }

  async function callApi(input: string | string[]): Promise<Float32Array[]> {
    const body = JSON.stringify({ model, input });

    let response: Response;
    try {
      response = await fetchFn(url, { method: 'POST', headers, body });
    } catch (err) {
      if (fallbackToMock) {
        const texts = Array.isArray(input) ? input : [input];
        return texts.map((t) => mockEmbed(t, dimensions));
      }
      throw err;
    }

    if (!response.ok) {
      if (fallbackToMock) {
        const texts = Array.isArray(input) ? input : [input];
        return texts.map((t) => mockEmbed(t, dimensions));
      }
      const text = await response.text();
      throw new Error(`LiteLLM embeddings error (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return json.data.map((d) => new Float32Array(d.embedding));
  }

  return {
    dimensions,

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

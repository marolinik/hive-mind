import { describe, it, expect } from 'vitest';
import {
  createEmbeddingProvider,
  capEmbedText,
  maxEmbedCharsForModel,
  reembedPerText,
} from './embedding-provider.js';
import type { Embedder } from './embeddings.js';

describe('createEmbeddingProvider', () => {
  it('falls back to mock when provider=mock is requested explicitly', async () => {
    const provider = await createEmbeddingProvider({ provider: 'mock' });
    expect(provider.getActiveProvider()).toBe('mock');
    const status = provider.getStatus();
    expect(status.activeProvider).toBe('mock');
    expect(status.availableProviders).toContain('mock');
    expect(status.dimensions).toBe(1024);
    expect(status.modelName).toBe('deterministic-mock');
  });

  it('respects targetDimensions when configured', async () => {
    const provider = await createEmbeddingProvider({
      provider: 'mock',
      targetDimensions: 512,
    });
    expect(provider.dimensions).toBe(512);
    const vec = await provider.embed('hello');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(512);
  });

  it('produces deterministic mock vectors for identical inputs', async () => {
    const provider = await createEmbeddingProvider({ provider: 'mock' });
    const a = await provider.embed('deterministic input');
    const b = await provider.embed('deterministic input');
    expect(a.length).toBe(1024);
    expect(b.length).toBe(1024);
    // Determinism: same text hashes to same bytes.
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  it('returns empty array for embedBatch([])', async () => {
    const provider = await createEmbeddingProvider({ provider: 'mock' });
    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
  });

  it('batch-embeds multiple inputs to the expected shape', async () => {
    const provider = await createEmbeddingProvider({
      provider: 'mock',
      targetDimensions: 256,
    });
    const out = await provider.embedBatch(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    for (const vec of out) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(256);
    }
  });

  it('falls back to mock when an explicit non-mock provider fails to probe', async () => {
    // litellm with an obviously-unroutable URL — probe should fail quickly and
    // the factory should land on mock.
    const provider = await createEmbeddingProvider({
      provider: 'litellm',
      litellm: { url: 'http://127.0.0.1:1' },
    });
    expect(provider.getActiveProvider()).toBe('mock');
    const status = provider.getStatus();
    expect(status.availableProviders).toEqual(['mock']);
  });

  it('reprobe() refreshes status and keeps mock available when nothing else is', async () => {
    const provider = await createEmbeddingProvider({ provider: 'mock' });
    const first = provider.getStatus().probeTimestamp;
    // Small delay so the timestamp can advance (Date.now resolution is ~1ms).
    await new Promise((r) => setTimeout(r, 5));
    const second = await provider.reprobe();
    expect(second.availableProviders).toContain('mock');
    expect(Date.parse(second.probeTimestamp)).toBeGreaterThanOrEqual(Date.parse(first));
  });
});

describe('embedding guards (oversized-frame truncation + skip-not-abort)', () => {
  it('capEmbedText truncates only inputs over the limit', () => {
    expect(capEmbedText('short', 6000)).toBe('short');
    expect(capEmbedText('x'.repeat(6000), 6000)).toHaveLength(6000); // exactly at limit: unchanged
    expect(capEmbedText('x'.repeat(20000), 6000)).toHaveLength(6000); // over limit: clamped
  });

  // Forward-ported from waggle-os monorepo (mono-parity 2026-06-12): the *-8k
  // branch was reduced 24000 → 8000 — '-8k' names can be architecture-capped
  // at 2048 tokens (nomic-bert), and a 24K-char cap mock-poisoned long frames.
  it('maxEmbedCharsForModel returns 8000 for 8k models and 6000 otherwise', () => {
    expect(maxEmbedCharsForModel('nomic-embed-text')).toBe(6000);
    expect(maxEmbedCharsForModel('voyage-3-lite')).toBe(6000);
    expect(maxEmbedCharsForModel('deterministic-mock')).toBe(6000);
    expect(maxEmbedCharsForModel('nomic-embed-text-8k')).toBe(8000);
    expect(maxEmbedCharsForModel('custom (num_ctx 8192)')).toBe(8000);
  });

  it('reembedPerText degrades ONLY the failing text, not the whole batch', async () => {
    // The regression: the provider used to mock-poison the WHOLE batch when one
    // text made the backend throw. Per-text re-embed keeps the good ones real.
    const realFirstByte = (t: string): Float32Array => {
      const v = new Float32Array(4);
      v[0] = t.length; // a "real" marker the mock can't produce for these strings
      return v;
    };
    const embedder: Embedder = {
      dimensions: 4,
      async embed(t: string) {
        if (t === 'POISON') throw new Error('backend rejected this input');
        return realFirstByte(t);
      },
      async embedBatch() {
        throw new Error('batch path not used in this test');
      },
    };

    const out = await reembedPerText(embedder, ['alpha', 'POISON', 'betas'], 4);
    expect(out).toHaveLength(3);
    expect(out[0][0]).toBe(5); // 'alpha' embedded for real
    expect(out[2][0]).toBe(5); // 'betas' embedded for real
    expect(out[1][0]).not.toBe(6); // 'POISON' degraded to mock, NOT a real length-6 vector
  });
});

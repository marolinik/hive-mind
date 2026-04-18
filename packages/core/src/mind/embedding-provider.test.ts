import { describe, it, expect } from 'vitest';
import { createEmbeddingProvider } from './embedding-provider.js';

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

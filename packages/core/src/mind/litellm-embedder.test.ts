import { describe, it, expect, vi } from 'vitest';
import { createLiteLLMEmbedder } from './litellm-embedder.js';

type FetchFn = typeof globalThis.fetch;

function makeOkResponse(embeddings: number[][]): Response {
  return new Response(JSON.stringify({ data: embeddings.map((e) => ({ embedding: e })) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createLiteLLMEmbedder', () => {
  it('calls the /v1/embeddings endpoint and returns embeddings verbatim', async () => {
    const fetchFn: FetchFn = vi.fn(async () => makeOkResponse([[0.1, 0.2, 0.3, 0.4]]));
    const embedder = createLiteLLMEmbedder({
      litellmUrl: 'http://example.local:4000',
      litellmApiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 4,
      fetch: fetchFn,
    });
    const vec = await embedder.embed('hello');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(4);
    expect(Array.from(vec).map((x) => Number(x.toFixed(1)))).toEqual([0.1, 0.2, 0.3, 0.4]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetchFn).mock.calls[0];
    const [url, init] = call;
    expect(url).toBe('http://example.local:4000/v1/embeddings');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('strips a trailing /v1 from the base URL before appending /v1/embeddings', async () => {
    const fetchFn: FetchFn = vi.fn(async () => makeOkResponse([[0, 0, 0]]));
    const embedder = createLiteLLMEmbedder({
      litellmUrl: 'http://example.local:4000/v1',
      dimensions: 3,
      fetch: fetchFn,
    });
    await embedder.embed('x');
    const [url] = vi.mocked(fetchFn).mock.calls[0];
    expect(url).toBe('http://example.local:4000/v1/embeddings');
  });

  it('throws on non-2xx responses when fallbackToMock is disabled', async () => {
    const fetchFn: FetchFn = vi.fn(
      async () =>
        new Response('boom', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
    );
    const embedder = createLiteLLMEmbedder({
      litellmUrl: 'http://example.local:4000',
      dimensions: 2,
      fetch: fetchFn,
    });
    await expect(embedder.embed('hello')).rejects.toThrow(/LiteLLM embeddings error \(500\)/);
  });

  it('falls back to a deterministic mock on fetch failure when fallbackToMock=true', async () => {
    const fetchFn: FetchFn = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const embedder = createLiteLLMEmbedder({
      litellmUrl: 'http://example.local:4000',
      dimensions: 8,
      fetch: fetchFn,
      fallbackToMock: true,
    });
    const a = await embedder.embed('deterministic');
    const b = await embedder.embed('deterministic');
    expect(a.length).toBe(8);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('falls back to mock on HTTP error when fallbackToMock=true', async () => {
    const fetchFn: FetchFn = vi.fn(
      async () => new Response('nope', { status: 503 }),
    );
    const embedder = createLiteLLMEmbedder({
      litellmUrl: 'http://example.local:4000',
      dimensions: 4,
      fetch: fetchFn,
      fallbackToMock: true,
    });
    const batch = await embedder.embedBatch(['a', 'b']);
    expect(batch).toHaveLength(2);
    for (const v of batch) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(4);
    }
  });

  it('returns [] for embedBatch([]) without calling fetch', async () => {
    const fetchFn: FetchFn = vi.fn(async () => makeOkResponse([[]]));
    const embedder = createLiteLLMEmbedder({
      litellmUrl: 'http://example.local:4000',
      dimensions: 4,
      fetch: fetchFn,
    });
    expect(await embedder.embedBatch([])).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSynthesizer } from './synthesizer.js';

describe('resolveSynthesizer', () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = ['ANTHROPIC_API_KEY', 'OLLAMA_URL', 'OLLAMA_MODEL'];

  beforeEach(() => {
    for (const k of envKeys) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    vi.unstubAllGlobals();
  });

  it('falls back to echo when no env vars or explicit config are present', async () => {
    const resolver = await resolveSynthesizer();
    expect(resolver.provider).toBe('echo');
    expect(resolver.model).toBe('echo');
    expect(typeof resolver.synthesize).toBe('function');
  });

  it('picks anthropic when ANTHROPIC_API_KEY is present and SDK is importable', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-ignored-for-resolution-check';
    const resolver = await resolveSynthesizer();
    // The SDK is a devDep so the import resolves in this repo — resolver should
    // select anthropic without ever contacting the API.
    expect(resolver.provider).toBe('anthropic');
    expect(resolver.model).toBe('claude-haiku-4-5-20251001');
  });

  it('honours anthropicModel override', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const resolver = await resolveSynthesizer({ anthropicModel: 'claude-opus-override' });
    expect(resolver.provider).toBe('anthropic');
    expect(resolver.model).toBe('claude-opus-override');
  });

  it('picks ollama over echo when OLLAMA_URL reports healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    const resolver = await resolveSynthesizer();
    expect(resolver.provider).toBe('ollama');
    expect(resolver.model).toBe('llama3.2');
  });

  it('honours OLLAMA_MODEL override when ollama is selected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    process.env.OLLAMA_MODEL = 'qwen3:7b';
    const resolver = await resolveSynthesizer();
    expect(resolver.provider).toBe('ollama');
    expect(resolver.model).toBe('qwen3:7b');
  });

  it('falls through to echo if ollama health check fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    const resolver = await resolveSynthesizer();
    expect(resolver.provider).toBe('echo');
  });

  it('echo synthesizer extracts entity name, frame count, and facts from the prompt', async () => {
    const resolver = await resolveSynthesizer();
    const prompt = `wiki about "Alice".

## Source Frames (3 total)
[Frame #7, 2026-04-18]: works at Acme Corp
[Frame #8, 2026-04-18]: role is engineer
[Frame #9, 2026-04-18]: based in Berlin
`;
    const out = await resolver.synthesize(prompt);
    expect(out).toContain('3 source frames');
    expect(out).toContain('Alice');
    expect(out).toContain('works at Acme Corp');
    expect(out).toContain('(#7)');
    expect(out).toContain('echo synthesizer');
    expect(out).toMatch(/ANTHROPIC_API_KEY or OLLAMA_URL/);
  });

  it('echo synthesizer tolerates concept-shaped prompts', async () => {
    const resolver = await resolveSynthesizer();
    const prompt = `wiki about the concept "Observability"

## Source Frames (1 total)
[Frame #1, 2026-04-18]: Observability = logs + metrics + traces.
`;
    const out = await resolver.synthesize(prompt);
    expect(out).toContain('Observability');
    expect(out).toContain('1 source frames');
  });
});

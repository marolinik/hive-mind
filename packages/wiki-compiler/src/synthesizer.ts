/**
 * LLM Synthesizer — resolves the best available LLM for wiki page synthesis.
 *
 * Priority chain:
 * 1. Anthropic Haiku (cheapest, fastest, best for synthesis)
 * 2. Ollama (free, local)
 * 3. Echo (no LLM, returns structured stub)
 *
 * All synthesizers implement LLMSynthesizeFn: (prompt: string) => Promise<string>
 */

import type { LLMSynthesizeFn } from './types.js';

export interface SynthesizerConfig {
  /** Anthropic API key. Falls back to process.env.ANTHROPIC_API_KEY if not provided. */
  anthropicApiKey?: string;
  /** Anthropic model id. Default: claude-haiku-4-5-20251001. */
  anthropicModel?: string;
  /** Ollama base URL. Falls back to process.env.OLLAMA_URL if not provided. */
  ollamaUrl?: string;
  /** Ollama model name (default: llama3.2). Falls back to process.env.OLLAMA_MODEL. */
  ollamaModel?: string;
  /** Max tokens for synthesis output (default: 1500) */
  maxTokens?: number;
}

// ── Anthropic (Haiku) ───────────────────────────────────────────

function createAnthropicSynthesizer(apiKey: string, model: string, maxTokens: number): LLMSynthesizeFn {
  return async (prompt: string): Promise<string> => {
    // Dynamic import — @anthropic-ai/sdk is an optional peer dep.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock?.text ?? '';
  };
}

// ── Ollama ──────────────────────────────────────────────────────

function createOllamaSynthesizer(baseUrl: string, model: string, maxTokens: number): LLMSynthesizeFn {
  return async (prompt: string): Promise<string> => {
    const url = `${baseUrl.replace(/\/$/, '')}/api/generate`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { response: string };
    return data.response ?? '';
  };
}

// ── Echo (fallback) ─────────────────────────────────────────────

function createEchoSynthesizer(): LLMSynthesizeFn {
  return async (prompt: string): Promise<string> => {
    const frameMatch = prompt.match(/\((\d+) total\)/);
    const frameCount = frameMatch ? frameMatch[1] : '?';
    const nameMatch = prompt.match(/about "([^"]+)"/) ?? prompt.match(/concept "([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : 'this topic';

    // Extract actual frame content for a basic summary
    const frameLines = (prompt.match(/\[Frame #\d+.*?\]: .+/g) || []);
    const facts = frameLines.slice(0, 8).map(line => {
      const m = line.match(/\[Frame (#\d+).*?\]: (.+)/);
      return m ? `- ${m[2].slice(0, 200)} *(${m[1]})*` : null;
    }).filter(Boolean);

    return `## Summary\nCompiled from ${frameCount} source frames about ${name}.\n\n` +
      (facts.length > 0 ? `## Key Facts\n${facts.join('\n')}\n\n` : '') +
      `> *Compiled with echo synthesizer. Connect an LLM for richer synthesis.*\n` +
      `> Set ANTHROPIC_API_KEY or OLLAMA_URL in your environment.`;
  };
}

// ── Resolver ────────────────────────────────────────────────────

export interface ResolvedSynthesizer {
  synthesize: LLMSynthesizeFn;
  provider: 'anthropic' | 'ollama' | 'echo';
  model: string;
}

/**
 * Resolve the best available LLM synthesizer.
 * Checks env vars and config, returns the first working option.
 */
export async function resolveSynthesizer(config?: SynthesizerConfig): Promise<ResolvedSynthesizer> {
  const maxTokens = config?.maxTokens ?? 1500;
  const anthropicModel = config?.anthropicModel ?? 'claude-haiku-4-5-20251001';

  // 1. Try Anthropic
  const anthropicKey = config?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;

  if (anthropicKey) {
    try {
      // Verify the SDK is importable
      await import('@anthropic-ai/sdk');
      return {
        synthesize: createAnthropicSynthesizer(anthropicKey, anthropicModel, maxTokens),
        provider: 'anthropic',
        model: anthropicModel,
      };
    } catch {
      // SDK not available — fall through
    }
  }

  // 2. Try Ollama
  const ollamaUrl = config?.ollamaUrl ?? process.env.OLLAMA_URL;
  const ollamaModel = config?.ollamaModel ?? process.env.OLLAMA_MODEL ?? 'llama3.2';

  if (ollamaUrl) {
    try {
      // Quick health check
      const health = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (health.ok) {
        return {
          synthesize: createOllamaSynthesizer(ollamaUrl, ollamaModel, maxTokens),
          provider: 'ollama',
          model: ollamaModel,
        };
      }
    } catch {
      // Ollama not reachable — fall through
    }
  }

  // 3. Echo fallback
  return {
    synthesize: createEchoSynthesizer(),
    provider: 'echo',
    model: 'echo',
  };
}

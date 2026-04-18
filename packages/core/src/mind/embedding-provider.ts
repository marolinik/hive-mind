/**
 * EmbeddingProvider — orchestrates the InProcess → Ollama → API → Mock fallback
 * chain. Single entry point for all embedding operations in @hive-mind/core.
 * Implements the Embedder interface — drop-in replacement everywhere.
 *
 * No tier or quota enforcement — hive-mind ships everything free. Downstream
 * consumers are free to layer their own authorization on top of
 * createEmbeddingProvider (e.g. wrap the returned instance and throw before
 * calling `embed` / `embedBatch`).
 *
 * Extracted from Waggle OS `packages/core/src/mind/embedding-provider.ts`.
 * Scrub:
 *   - Removed `@waggle/shared` tier/quota imports (Tier, TIERS, TIER_CAPABILITIES,
 *     TierError).
 *   - Removed per-user monthly quota tracking table + helper functions.
 *   - Removed EmbeddingQuotaExceededError (quota lives in Waggle's billing layer).
 *   - Removed WAGGLE_EVAL_MODE escape hatch (no tier system to bypass).
 *   - Removed quotaDb / userTier / userId config fields.
 *   - Removed getQuotaStatus method from EmbeddingProviderInstance.
 *   - Probe string rebranded "waggle embedding probe" → "hive-mind embedding probe".
 *   - "no API key in Vault" log strings generalized to "no API key configured".
 */

import type { Embedder } from './embeddings.js';
import { createCoreLogger } from '../logger.js';

const log = createCoreLogger('embedding');

export type EmbeddingProviderType =
  | 'inprocess'
  | 'ollama'
  | 'voyage'
  | 'openai'
  | 'litellm'
  | 'mock';

export interface EmbeddingProviderConfig {
  provider?: EmbeddingProviderType | 'auto';
  targetDimensions?: number;
  inprocess?: { model?: string; cacheDir?: string };
  ollama?: { baseUrl?: string; model?: string };
  voyage?: { apiKey: string; model?: string };
  openai?: { apiKey: string; model?: string };
  litellm?: { url: string; apiKey?: string; model?: string };
}

export interface EmbeddingProviderStatus {
  activeProvider: EmbeddingProviderType;
  availableProviders: EmbeddingProviderType[];
  dimensions: number;
  modelName: string;
  lastError?: string;
  probeTimestamp: string;
}

export interface EmbeddingProviderInstance extends Embedder {
  getStatus(): EmbeddingProviderStatus;
  getActiveProvider(): EmbeddingProviderType;
  reprobe(): Promise<EmbeddingProviderStatus>;
}

/** Deterministic mock — last resort, semantically meaningless. */
function mockEmbed(text: string, dims: number): Float32Array {
  const arr = new Float32Array(dims);
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < Math.min(bytes.length, dims); i++) {
    arr[i] = (bytes[i] - 128) / 128;
  }
  return arr;
}

function createMockEmbedder(dims: number): Embedder {
  return {
    dimensions: dims,
    async embed(text: string) {
      return mockEmbed(text, dims);
    },
    async embedBatch(texts: string[]) {
      return texts.map((t) => mockEmbed(t, dims));
    },
  };
}

interface ProbeResult {
  type: EmbeddingProviderType;
  embedder: Embedder;
  modelName: string;
}

const PROBE_TEXT = 'hive-mind embedding probe';

async function probeProvider(
  type: EmbeddingProviderType,
  config: EmbeddingProviderConfig,
): Promise<ProbeResult | null> {
  const dims = config.targetDimensions ?? 1024;

  try {
    switch (type) {
      case 'inprocess': {
        const { createInProcessEmbedder } = await import('./inprocess-embedder.js');
        const embedder = await createInProcessEmbedder({
          model: config.inprocess?.model,
          cacheDir: config.inprocess?.cacheDir,
          targetDimensions: dims,
        });
        const test = await embedder.embed(PROBE_TEXT);
        if (test.length !== dims) throw new Error(`Unexpected dims: ${test.length}`);
        return {
          type: 'inprocess',
          embedder,
          modelName: config.inprocess?.model ?? 'Xenova/all-MiniLM-L6-v2',
        };
      }

      case 'ollama': {
        const { createOllamaEmbedder } = await import('./ollama-embedder.js');
        const embedder = createOllamaEmbedder({
          baseUrl: config.ollama?.baseUrl,
          model: config.ollama?.model,
          targetDimensions: dims,
        });
        const test = await embedder.embed(PROBE_TEXT);
        if (test.length !== dims) throw new Error(`Unexpected dims: ${test.length}`);
        return {
          type: 'ollama',
          embedder,
          modelName: config.ollama?.model ?? 'nomic-embed-text',
        };
      }

      case 'voyage': {
        if (!config.voyage?.apiKey) return null;
        const { createApiEmbedder } = await import('./api-embedder.js');
        const embedder = createApiEmbedder({
          provider: 'voyage',
          apiKey: config.voyage.apiKey,
          model: config.voyage.model,
          targetDimensions: dims,
        });
        const test = await embedder.embed(PROBE_TEXT);
        if (test.length !== dims) throw new Error(`Unexpected dims: ${test.length}`);
        return {
          type: 'voyage',
          embedder,
          modelName: config.voyage.model ?? 'voyage-3-lite',
        };
      }

      case 'openai': {
        if (!config.openai?.apiKey) return null;
        const { createApiEmbedder } = await import('./api-embedder.js');
        const embedder = createApiEmbedder({
          provider: 'openai',
          apiKey: config.openai.apiKey,
          model: config.openai.model,
          targetDimensions: dims,
        });
        const test = await embedder.embed(PROBE_TEXT);
        if (test.length !== dims) throw new Error(`Unexpected dims: ${test.length}`);
        return {
          type: 'openai',
          embedder,
          modelName: config.openai.model ?? 'text-embedding-3-small',
        };
      }

      case 'litellm': {
        if (!config.litellm?.url) return null;
        const { createLiteLLMEmbedder } = await import('./litellm-embedder.js');
        const embedder = createLiteLLMEmbedder({
          litellmUrl: config.litellm.url,
          litellmApiKey: config.litellm.apiKey,
          model: config.litellm.model ?? 'text-embedding',
          dimensions: dims,
          fallbackToMock: false,
        });
        const test = await embedder.embed(PROBE_TEXT);
        if (test.length !== dims) throw new Error(`Unexpected dims: ${test.length}`);
        return {
          type: 'litellm',
          embedder,
          modelName: config.litellm.model ?? 'text-embedding',
        };
      }

      default:
        return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`Trying ${type}... FAILED (${msg})`);
    return null;
  }
}

export async function createEmbeddingProvider(
  config?: EmbeddingProviderConfig,
): Promise<EmbeddingProviderInstance> {
  const cfg: EmbeddingProviderConfig = {
    provider: 'auto',
    targetDimensions: 1024,
    ...config,
  };
  const dims = cfg.targetDimensions ?? 1024;

  let activeResult: ProbeResult | null = null;
  let activeEmbedder: Embedder;
  let activeType: EmbeddingProviderType = 'mock';
  let activeModelName = 'deterministic-mock';
  let lastError: string | undefined;
  let availableProviders: EmbeddingProviderType[] = [];
  let probeTimestamp = new Date().toISOString();

  async function runProbe(): Promise<void> {
    log.info('Probing embedding providers...');
    const available: EmbeddingProviderType[] = [];
    activeResult = null;
    probeTimestamp = new Date().toISOString();

    const requestedProvider = cfg.provider ?? 'auto';

    if (requestedProvider !== 'auto' && requestedProvider !== 'mock') {
      log.info(`Trying ${requestedProvider}...`);
      const result = await probeProvider(requestedProvider, cfg);
      if (result) {
        activeResult = result;
        available.push(result.type);
        log.info(`Trying ${requestedProvider}... OK`);
      }
    } else if (requestedProvider === 'auto') {
      const chain: EmbeddingProviderType[] = ['inprocess', 'ollama', 'voyage', 'openai'];

      for (const providerType of chain) {
        if (providerType === 'voyage' && !cfg.voyage?.apiKey) {
          log.info('Skipping voyage (no API key configured)');
          continue;
        }
        if (providerType === 'openai' && !cfg.openai?.apiKey) {
          log.info('Skipping openai (no API key configured)');
          continue;
        }

        log.info(`Trying ${providerType}...`);
        const result = await probeProvider(providerType, cfg);
        if (result) {
          available.push(result.type);
          log.info(`Trying ${providerType}... OK`);
          if (!activeResult) {
            activeResult = result;
          }
        }
      }
    }

    available.push('mock'); // always available
    availableProviders = available;

    if (activeResult) {
      activeEmbedder = activeResult.embedder;
      activeType = activeResult.type;
      activeModelName = activeResult.modelName;
      lastError = undefined;
      log.info(`Embedding provider: ${activeType} (${activeModelName}, ${dims} dims)`);
    } else {
      activeEmbedder = createMockEmbedder(dims);
      activeType = 'mock';
      activeModelName = 'deterministic-mock';
      lastError = 'No real providers available';
      log.info(
        'Embedding provider: mock (no real providers available — semantic search quality degraded)',
      );
    }
  }

  try {
    await runProbe();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    activeEmbedder = createMockEmbedder(dims);
    activeType = 'mock';
    activeModelName = 'deterministic-mock';
    availableProviders = ['mock'];
  }

  // Ensure activeEmbedder is assigned (TypeScript flow analysis).
  activeEmbedder ??= createMockEmbedder(dims);

  const instance: EmbeddingProviderInstance = {
    dimensions: dims,

    async embed(text: string): Promise<Float32Array> {
      try {
        return await activeEmbedder.embed(text);
      } catch (err) {
        log.warn(
          `Embedding failed with ${activeType}, falling back to mock: ${(err as Error).message}`,
        );
        lastError = (err as Error).message;
        return mockEmbed(text, dims);
      }
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      try {
        return await activeEmbedder.embedBatch(texts);
      } catch (err) {
        log.warn(
          `Batch embedding failed with ${activeType}, falling back to mock: ${(err as Error).message}`,
        );
        lastError = (err as Error).message;
        return texts.map((t) => mockEmbed(t, dims));
      }
    },

    getStatus(): EmbeddingProviderStatus {
      return {
        activeProvider: activeType,
        availableProviders,
        dimensions: dims,
        modelName: activeModelName,
        lastError,
        probeTimestamp,
      };
    },

    getActiveProvider(): EmbeddingProviderType {
      return activeType;
    },

    async reprobe(): Promise<EmbeddingProviderStatus> {
      await runProbe();
      return instance.getStatus();
    },
  };

  return instance;
}

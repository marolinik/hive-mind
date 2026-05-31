/**
 * Shared CLI setup — resolves the data directory and opens the personal
 * MindDB on demand. Kept deliberately thin: each command instantiates
 * only the layers it needs, so `recall-context` doesn't pay the cost of
 * an embedder probe when the user only wants keyword search.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  MindDB,
  FrameStore,
  HybridSearch,
  KnowledgeGraph,
  IdentityLayer,
  AwarenessLayer,
  SessionStore,
  HarvestSourceStore,
  WorkspaceManager,
  MultiMindCache,
  createEmbeddingProvider,
  createInProcessReranker,
  type EmbeddingProviderConfig,
  type EmbeddingProviderInstance,
  type Reranker,
} from '@hive-mind/core';

export interface CliEnv {
  dataDir: string;
  db: MindDB;
  frames: FrameStore;
  kg: KnowledgeGraph;
  identity: IdentityLayer;
  awareness: AwarenessLayer;
  sessions: SessionStore;
  harvestSources: HarvestSourceStore;
  workspaces: WorkspaceManager;
  mindCache: MultiMindCache;
  /** Lazily-probed embedder. Call `getEmbedder()` — subsequent calls reuse the same instance. */
  getEmbedder: () => Promise<EmbeddingProviderInstance>;
  /** Search against the personal mind with an embedder lazily resolved on first call. */
  getSearch: () => Promise<HybridSearch>;
  /**
   * Lazily-loaded cross-encoder reranker (~22MB on first call). Returns
   * undefined if @huggingface/transformers isn't installed or model load
   * fails — callers should handle null gracefully and skip reranking.
   */
  getReranker: () => Promise<Reranker | undefined>;
  close: () => void;
}

/** Resolve HIVE_MIND_DATA_DIR with ~ expansion; defaults to ~/.hive-mind. */
export function resolveDataDir(): string {
  const envDir = process.env.HIVE_MIND_DATA_DIR;
  if (envDir) {
    if (envDir.startsWith('~')) {
      return path.join(os.homedir(), envDir.slice(1));
    }
    return envDir;
  }
  return path.join(os.homedir(), '.hive-mind');
}

/**
 * Resolve an embedding-provider config from the same env vars as the MCP
 * server so a single `.env` file can configure both.
 *
 * Priority (highest first):
 *   1. HIVE_MIND_EMBEDDING_PROVIDER explicit override
 *   2. OLLAMA_URL set                          → ollama at custom URL
 *   3. VOYAGE_API_KEY                          → voyage
 *   4. OPENAI_API_KEY                          → openai
 *   5. (default) ollama at http://localhost:11434
 *      — most users running Ollama use the default port. The probe fails
 *      fast (~30ms) if it's not running, then the chain falls to mock.
 *      Avoids the silent "always mock" trap that bit Phase 3b-3 audit.
 *      Skip the InProcess auto-probe to avoid a surprise 23MB download.
 */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';

function embedderConfigFromEnv(dataDir: string): EmbeddingProviderConfig {
  const explicit = process.env.HIVE_MIND_EMBEDDING_PROVIDER as
    | EmbeddingProviderConfig['provider']
    | undefined;

  let provider: EmbeddingProviderConfig['provider'];
  if (explicit) {
    provider = explicit;
  } else if (process.env.OLLAMA_URL) {
    provider = 'ollama';
  } else if (process.env.VOYAGE_API_KEY) {
    provider = 'voyage';
  } else if (process.env.OPENAI_API_KEY) {
    provider = 'openai';
  } else {
    // No explicit config — try Ollama at default URL. Fails fast if absent.
    provider = 'ollama';
  }

  return {
    provider,
    targetDimensions: 1024,
    inprocess: { cacheDir: path.join(dataDir, 'models') },
    ollama: {
      baseUrl: process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
      model: process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
    },
    ...(process.env.VOYAGE_API_KEY && {
      voyage: {
        apiKey: process.env.VOYAGE_API_KEY,
        // voyage-3 is 1024 dims (matches our schema); voyage-3-lite is 512.
        // Multilingual workloads should set VOYAGE_MODEL=voyage-multilingual-2.
        model: process.env.VOYAGE_MODEL ?? 'voyage-3',
      },
    }),
    ...(process.env.OPENAI_API_KEY && {
      openai: {
        apiKey: process.env.OPENAI_API_KEY,
        // text-embedding-3-small native is 1536 dims; we set targetDimensions
        // to 1024 above which the api-embedder slices via Matryoshka. If you
        // need a different cap, set OPENAI_MODEL to text-embedding-3-large
        // (3072 native dims, also Matryoshka-truncatable).
        model: process.env.OPENAI_MODEL ?? 'text-embedding-3-small',
      },
    }),
  };
}

/**
 * Open the personal mind + wire every layer. Use the returned `close()`
 * to release file handles before the process exits (important on
 * Windows, where better-sqlite3 journal files linger otherwise).
 */
export function openPersonalMind(dataDir: string = resolveDataDir()): CliEnv {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'personal.mind');
  const db = new MindDB(dbPath);

  const frames = new FrameStore(db);
  const kg = new KnowledgeGraph(db);
  const identity = new IdentityLayer(db);
  const awareness = new AwarenessLayer(db);
  const sessions = new SessionStore(db);
  const harvestSources = new HarvestSourceStore(db);
  const workspaces = new WorkspaceManager(dataDir);
  const mindCache = new MultiMindCache({
    maxOpen: 20,
    getMindPath: (id: string) => workspaces.getMindPath(id),
  });

  let _embedder: EmbeddingProviderInstance | null = null;
  let _search: HybridSearch | null = null;
  let _reranker: Reranker | undefined | null = null; // null = unattempted; undefined = attempted-and-failed

  const getEmbedder = async (): Promise<EmbeddingProviderInstance> => {
    if (_embedder) return _embedder;
    _embedder = await createEmbeddingProvider(embedderConfigFromEnv(dataDir));
    return _embedder;
  };

  const getSearch = async (): Promise<HybridSearch> => {
    if (_search) return _search;
    const embedder = await getEmbedder();
    _search = new HybridSearch(db, embedder);
    return _search;
  };

  const getReranker = async (): Promise<Reranker | undefined> => {
    if (_reranker !== null) return _reranker ?? undefined;
    // Opt-out for CI / headless / resource-constrained environments: skip the
    // ~87MB ONNX cross-encoder load entirely. Reranking is an optional
    // re-ordering of the RRF survivors — search still works without it.
    if (process.env.HIVE_MIND_NO_RERANK === '1' || process.env.HIVE_MIND_NO_RERANK === 'true') {
      _reranker = undefined;
      return undefined;
    }
    try {
      _reranker = await createInProcessReranker({
        cacheDir: path.join(dataDir, 'models'),
      });
      return _reranker;
    } catch (err) {
      // peer dep not installed, model load failed, network blip on first
      // download — soft fail. Search still works without reranker.
      _reranker = undefined;
      return undefined;
    }
  };

  return {
    dataDir,
    db,
    frames,
    kg,
    identity,
    awareness,
    sessions,
    harvestSources,
    workspaces,
    mindCache,
    getEmbedder,
    getSearch,
    getReranker,
    close: () => {
      mindCache.closeAll();
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

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
  type EmbeddingProviderConfig,
  type EmbeddingProviderInstance,
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
 */
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
    provider = 'mock';
  }

  return {
    provider,
    targetDimensions: 1024,
    inprocess: { cacheDir: path.join(dataDir, 'models') },
    ollama: {
      baseUrl: process.env.OLLAMA_URL,
      model: process.env.OLLAMA_MODEL,
    },
    ...(process.env.VOYAGE_API_KEY && {
      voyage: { apiKey: process.env.VOYAGE_API_KEY },
    }),
    ...(process.env.OPENAI_API_KEY && {
      openai: { apiKey: process.env.OPENAI_API_KEY },
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
    close: () => {
      mindCache.closeAll();
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

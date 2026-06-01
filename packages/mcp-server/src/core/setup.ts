/**
 * Core setup — initialises MindDB, embedding provider, workspace manager.
 * All state lives here; tool handlers import from this module.
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
  WorkspaceManager,
  MultiMindCache,
  createEmbeddingProvider,
  createInProcessReranker,
  HarvestSourceStore,
  ChatGPTAdapter,
  ClaudeAdapter,
  ClaudeCodeAdapter,
  GeminiAdapter,
  UniversalAdapter,
  MarkdownAdapter,
  PlaintextAdapter,
  UrlAdapter,
  PdfAdapter,
  type EmbeddingProviderInstance,
  type EmbeddingProviderConfig,
  type Reranker,
} from '@hive-mind/core';

// ── Data directory ──────────────────────────────────────────────────

function resolveDataDir(): string {
  const envDir = process.env.HIVE_MIND_DATA_DIR;
  if (envDir) {
    const resolved = envDir.startsWith('~')
      ? path.join(os.homedir(), envDir.slice(1))
      : envDir;
    return resolved;
  }
  return path.join(os.homedir(), '.hive-mind');
}

// ── Singleton state ─────────────────────────────────────────────────

let _initialized = false;

let _dataDir: string;
let _personalDb: MindDB;
let _frameStore: FrameStore;
let _search: HybridSearch;
let _knowledgeGraph: KnowledgeGraph;
let _identity: IdentityLayer;
let _awareness: AwarenessLayer;
let _sessions: SessionStore;
let _workspaceManager: WorkspaceManager;
let _mindCache: MultiMindCache;
let _embedder: EmbeddingProviderInstance;
let _harvestSourceStore: HarvestSourceStore;
let _reranker: Reranker | undefined | null = null; // null = unattempted; undefined = attempted-and-failed

// ── Harvest adapters (stateless, instantiate once) ──────────────────

const _chatgptAdapter = new ChatGPTAdapter();
const _claudeAdapter = new ClaudeAdapter();
const _claudeCodeAdapter = new ClaudeCodeAdapter();
const _geminiAdapter = new GeminiAdapter();
const _universalAdapter = new UniversalAdapter();
const _markdownAdapter = new MarkdownAdapter();
const _plaintextAdapter = new PlaintextAdapter();
const _urlAdapter = new UrlAdapter();
const _pdfAdapter = new PdfAdapter();

export function getAdapter(source: string) {
  switch (source) {
    case 'chatgpt': return _chatgptAdapter;
    case 'claude': return _claudeAdapter;
    case 'claude-code': return _claudeCodeAdapter;
    case 'gemini': return _geminiAdapter;
    case 'markdown': return _markdownAdapter;
    case 'plaintext': return _plaintextAdapter;
    case 'url': return _urlAdapter;
    case 'pdf': return _pdfAdapter;
    default: return _universalAdapter;
  }
}

// ── Initialization ──────────────────────────────────────────────────

export async function initialize(): Promise<void> {
  if (_initialized) return;

  _dataDir = resolveDataDir();

  // Ensure data directory exists
  fs.mkdirSync(_dataDir, { recursive: true });

  const personalMindPath = path.join(_dataDir, 'personal.mind');

  // Open the personal mind database
  _personalDb = new MindDB(personalMindPath);

  // Initialize layers on personal mind
  _frameStore = new FrameStore(_personalDb);
  _knowledgeGraph = new KnowledgeGraph(_personalDb);
  _identity = new IdentityLayer(_personalDb);
  _awareness = new AwarenessLayer(_personalDb);
  _sessions = new SessionStore(_personalDb);
  _harvestSourceStore = new HarvestSourceStore(_personalDb);

  // Resolve embedding provider — avoid surprise 23MB InProcess download.
  // Priority: explicit env → Ollama (if URL set) → API keys → mock fallback.
  // Users opt into InProcess via HIVE_MIND_EMBEDDING_PROVIDER=inprocess or =auto.
  const explicitProvider = process.env.HIVE_MIND_EMBEDDING_PROVIDER as EmbeddingProviderConfig['provider'] | undefined;
  let resolvedProvider: EmbeddingProviderConfig['provider'];

  if (explicitProvider) {
    resolvedProvider = explicitProvider;
  } else if (process.env.OLLAMA_URL) {
    resolvedProvider = 'ollama';
  } else if (process.env.VOYAGE_API_KEY) {
    resolvedProvider = 'voyage';
  } else if (process.env.OPENAI_API_KEY) {
    resolvedProvider = 'openai';
  } else {
    resolvedProvider = 'mock';
    console.error('[hive-mind-memory] No embedding provider configured — using keyword search only.');
    console.error('[hive-mind-memory] For semantic search, set one of:');
    console.error('[hive-mind-memory]   OLLAMA_URL=http://localhost:11434           (recommended, free)');
    console.error('[hive-mind-memory]   HIVE_MIND_EMBEDDING_PROVIDER=inprocess      (downloads 23MB model once)');
    console.error('[hive-mind-memory]   OPENAI_API_KEY=sk-...                       (remote API)');
  }

  const embeddingConfig: EmbeddingProviderConfig = {
    provider: resolvedProvider,
    targetDimensions: 1024,
    inprocess: {
      cacheDir: path.join(_dataDir, 'models'),
    },
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

  _embedder = await createEmbeddingProvider(embeddingConfig);

  // Initialize hybrid search with the embedding provider
  _search = new HybridSearch(_personalDb, _embedder);

  // Initialize workspace manager
  _workspaceManager = new WorkspaceManager(_dataDir);

  // LRU cache of open workspace MindDB handles (max 20)
  _mindCache = new MultiMindCache({
    maxOpen: 20,
    getMindPath: (workspaceId: string) => _workspaceManager.getMindPath(workspaceId),
  });

  _initialized = true;
}

// ── Accessors ───────────────────────────────────────────────────────

export function getDataDir(): string { return _dataDir; }
export function getPersonalDb(): MindDB { return _personalDb; }
export function getFrameStore(): FrameStore { return _frameStore; }
export function getSearch(): HybridSearch { return _search; }
export function getKnowledgeGraph(): KnowledgeGraph { return _knowledgeGraph; }
export function getIdentity(): IdentityLayer { return _identity; }
export function getAwareness(): AwarenessLayer { return _awareness; }
export function getSessions(): SessionStore { return _sessions; }
export function getWorkspaceManager(): WorkspaceManager { return _workspaceManager; }
export function getMindCache(): MultiMindCache { return _mindCache; }
export function getEmbedder(): EmbeddingProviderInstance { return _embedder; }
export function getHarvestSourceStore(): HarvestSourceStore { return _harvestSourceStore; }

/**
 * Lazy-load the cross-encoder reranker, memoized across calls.
 *
 * Mirrors the CLI's env.getReranker() (packages/cli/src/setup.ts) so the MCP
 * recall path reranks identically to `hive-mind recall-context` — otherwise
 * MCP clients silently get a worse-ordered result set than CLI users.
 *
 * Opt-out via HIVE_MIND_NO_RERANK=1 (CI / headless / low-resource): skips the
 * ~87MB ONNX load. Reranking only re-orders the RRF survivors, so search still
 * works without it; a load failure soft-fails to undefined.
 */
export async function getReranker(): Promise<Reranker | undefined> {
  if (_reranker !== null) return _reranker ?? undefined;
  if (process.env.HIVE_MIND_NO_RERANK === '1' || process.env.HIVE_MIND_NO_RERANK === 'true') {
    _reranker = undefined;
    return undefined;
  }
  try {
    _reranker = await createInProcessReranker({
      cacheDir: path.join(_dataDir, 'models'),
    });
    return _reranker;
  } catch {
    // peer dep missing, model load failed, or first-download network blip —
    // soft fail; RRF ordering still applies.
    _reranker = undefined;
    return undefined;
  }
}

// ── Workspace mind layer cache ──────────────────────────────────────
// Avoids re-creating FrameStore/HybridSearch/KnowledgeGraph/SessionStore
// on every getWorkspaceMind() call. Invalidates when MindDB reference
// changes (i.e. the LRU cache evicted and reopened it).

interface WorkspaceMindHandle {
  db: MindDB;
  frameStore: FrameStore;
  search: HybridSearch;
  knowledgeGraph: KnowledgeGraph;
  sessions: SessionStore;
}

const _workspaceMindLayerCache = new Map<string, WorkspaceMindHandle>();

/**
 * Get a workspace's MindDB, FrameStore, HybridSearch, and KnowledgeGraph.
 * Opens the mind on demand via the LRU cache. Layers are cached and
 * invalidated when the underlying MindDB handle changes.
 */
export function getWorkspaceMind(workspaceId: string): WorkspaceMindHandle | null {
  const db = _mindCache.getOrOpen(workspaceId);
  if (!db) return null;

  // Return cached layers if the MindDB reference is still the same
  const cached = _workspaceMindLayerCache.get(workspaceId);
  if (cached && cached.db === db) return cached;

  const handle: WorkspaceMindHandle = {
    db,
    frameStore: new FrameStore(db),
    search: new HybridSearch(db, _embedder),
    knowledgeGraph: new KnowledgeGraph(db),
    sessions: new SessionStore(db),
  };
  _workspaceMindLayerCache.set(workspaceId, handle);
  return handle;
}

// ── Shutdown ────────────────────────────────────────────────────────

export function shutdown(): void {
  _workspaceMindLayerCache.clear();
  _mindCache.closeAll();
  try { _personalDb?.close(); } catch { /* already closed */ }
  _reranker = null;
  _initialized = false;
}

/**
 * Phase 3e-polish (B5, 2026-05-08) — semantic verification of heuristic
 * detector candidates via ollama embeddings.
 *
 * Why this exists: the regex/keyword heuristics in failure-recall.js and
 * contradiction-detector.js have a real failure mode — they fire on broad
 * keyword overlap that's topically off (e.g. a SocialPresence harvested
 * .mind chunk firing as a "failure pattern" because "podcast" + "cognition"
 * happened to overlap with the prompt). The bookkeeping filter (Phase A)
 * killed the worst noise; this module catches the residue.
 *
 * Strategy: when a heuristic flags a candidate, embed both the prompt and
 * the candidate text using the local ollama instance. If their cosine
 * similarity is above a threshold, the candidate is semantically related
 * to the prompt and the warning is surfaced. Below threshold, drop it.
 *
 * Off by default — opt in with HIVE_MIND_VERIFY_LLM=1. The heuristic
 * remains fully functional without ollama; this is a quality lift, not a
 * dependency.
 *
 * Architectural note: this is the FIRST direct HTTP call from the hook
 * layer (everything else goes through MCP). Cleaner long-term home would
 * be an `embed_text` MCP tool in hive-mind core, but that requires upstream
 * changes; HTTP-direct is the shipping-speed compromise.
 */

// Read env at CALL time, not module-load time, so the hook picks up changes
// across invocations and tests can mutate behavior. The synth-drain pipeline
// also benefits — it runs in subprocesses that may have a different env
// than the spawning hook.
const ollamaUrl = () => process.env.OLLAMA_URL || 'http://localhost:11434';
// nomic-embed-text-8k is the custom 8192-context variant Marko's hive-mind
// already uses. Tag-less request hits `:latest`; ollama returns 404 if the
// model isn't installed → fail-open per the embed() error path.
const ollamaModel = () => process.env.HIVE_MIND_VERIFY_MODEL || 'nomic-embed-text-8k';
// Calibrated 2026-05-08 against real pairs:
//   "write a unit test that mocks the db" vs "Don't mock the db" → 0.796 (true pos)
//   "stub the db connection"              vs "Don't mock the db" → 0.586 (true pos, semantic)
//   "add Stripe to the checkout flow"     vs "Don't mock the db" → 0.449 (true neg)
//   "podcast intelligence cognition"      vs "build crashed"     → 0.376 (type-C neg)
// 0.55 catches stub-as-mock semantic matches while dropping unrelated 0.4-0.5.
const DEFAULT_THRESHOLD = 0.55;

/**
 * @returns {boolean}
 */
export function isVerifyEnabled() {
  return process.env.HIVE_MIND_VERIFY_LLM === '1';
}

/**
 * @returns {number}
 */
function getThreshold() {
  const raw = process.env.HIVE_MIND_VERIFY_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_THRESHOLD;
}

/**
 * Embed a string via ollama HTTP API. Returns the float[] embedding or
 * null on any failure (network down, model missing, abort, JSON malformed).
 *
 * Hard 1.5 s timeout per request — the hook has 4 s total to play with;
 * we can afford a few of these but not unbounded.
 *
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function embed(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${ollamaUrl()}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaModel(), prompt: text }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.embedding) && data.embedding.length > 0 ? data.embedding : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Cosine similarity between two equal-length vectors. Returns 0 for any
 * malformed input (mismatched lengths, zero-norm vectors, non-arrays).
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Filter heuristic detector candidates by semantic similarity to the
 * prompt. Fail-open: if the verifier is disabled OR ollama is unreachable
 * OR the prompt embed fails, the candidates pass through unchanged. Only
 * SUCCESSFUL embeddings can drop a candidate — never partial failures.
 *
 * The prompt is embedded ONCE (not per candidate) for efficiency.
 *
 * @template T
 * @param {string} prompt
 * @param {T[]} candidates
 * @param {(c: T) => string} getCandidateText
 * @param {{threshold?: number}} [opts]
 * @returns {Promise<T[]>}
 */
export async function semanticFilter(prompt, candidates, getCandidateText, opts = {}) {
  if (!isVerifyEnabled()) return candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : getThreshold();

  const promptEmb = await embed(prompt);
  if (!promptEmb) return candidates;  // fail-open: ollama down

  const verified = [];
  // Sequential to keep per-call timeouts independent. With max 2-4
  // candidates the parallelism gain is small; a slow ollama instance
  // would otherwise pile up four 1.5 s aborts in parallel.
  for (const c of candidates) {
    const text = String(getCandidateText(c) || '');
    if (!text) {
      verified.push(c);  // fail-open: nothing to compare
      continue;
    }
    const emb = await embed(text);
    if (!emb) {
      verified.push(c);  // fail-open: per-candidate failure
      continue;
    }
    const score = cosine(promptEmb, emb);
    if (score >= threshold) {
      // Annotate the candidate with the semantic score so callers can
      // surface it in UI ("matched on: X · semantic 0.72") if useful.
      // Non-mutating — return a shallow copy.
      verified.push({ ...c, semanticScore: Math.round(score * 1000) / 1000 });
    }
  }
  return verified;
}

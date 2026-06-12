/**
 * EQUIVALENCE GOLDEN-DIFF — embed-truncation
 * ==========================================
 *
 * This spec is the rigorous justification for deleting the legacy one-shot
 * script `D:/Projects/.harvest/embed-with-truncation.cjs`. It proves that the
 * in-repo embed-truncation surface (capEmbedText / maxEmbedCharsForModel /
 * reembedPerText / mockEmbed and the embed()/embedBatch() wrappers in
 * embedding-provider.ts) is behaviourally equivalent to — or a documented,
 * intentional superset of — the legacy script's two pure expressions.
 *
 * METHOD (fully hermetic — zero DB, zero network, zero Ollama, never touches
 * ~/.hive-mind or D:/Projects operator data):
 *   The .cjs has NO exports — it self-executes against a real personal.mind on
 *   `require`. We therefore do NOT require() it. Instead we transcribe its two
 *   pure expressions VERBATIM as local reference functions and diff them against
 *   the in-repo functions over a fixed fixture set. Every comparison is
 *   deterministic and in-memory.
 *
 * Legacy reference expressions (from embed-with-truncation.cjs):
 *   line 11:  const MAX_CHARS = 6000;
 *   line 19:  const truncated = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
 *   line 31-35: function fitDim(vec, target) {
 *                 if (vec.length === target) return vec;
 *                 if (vec.length > target) return vec.slice(0, target);
 *                 return [...vec, ...new Array(target - vec.length).fill(0)];
 *               }
 *
 * Each `documentedDelta` from the equivalence contract gets an EXPLICIT
 * assertion so the divergence is locked in as intentional-and-tested.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createEmbeddingProvider,
  capEmbedText,
  maxEmbedCharsForModel,
  reembedPerText,
} from './embedding-provider.js';
import type { Embedder } from './embeddings.js';

// Hermetic guard: never load the ~87MB ONNX reranker, never hit a network/
// embedding provider. The mock path is deterministic and provider-free.
beforeAll(() => {
  process.env.HIVE_MIND_NO_RERANK = '1';
});

// ── Legacy reference, transcribed VERBATIM from embed-with-truncation.cjs ──────
const LEGACY_MAX_CHARS = 6000; // .cjs line 11
/** .cjs line 19, character-for-character. */
const legacyTruncate = (text: string): string =>
  text.length > LEGACY_MAX_CHARS ? text.slice(0, LEGACY_MAX_CHARS) : text;
/** .cjs lines 31-35, character-for-character (operates on number[]). */
function legacyFitDim(vec: number[], target: number): number[] {
  if (vec.length === target) return vec;
  if (vec.length > target) return vec.slice(0, target);
  return [...vec, ...new Array(target - vec.length).fill(0)];
}

// ── Recompute mockEmbed independently (the contract formula) for value pinning ─
// arr = new Float32Array(dims); bytes = TextEncoder().encode(text);
// for i in [0, min(bytes.length, dims)): arr[i] = (bytes[i] - 128) / 128.
function expectedMockEmbed(text: string, dims: number): Float32Array {
  const arr = new Float32Array(dims);
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < Math.min(bytes.length, dims); i++) {
    arr[i] = (bytes[i] - 128) / 128;
  }
  return arr;
}

describe('embed-truncation equivalence golden-diff (justifies deleting .harvest/embed-with-truncation.cjs)', () => {
  // The fixed fixture set spanning under-cap, at-cap, the off-by-one boundary,
  // far-over-cap, and a multibyte string straddling the boundary.
  const FIXTURES: Array<{ name: string; text: string }> = [
    { name: 'empty', text: '' },
    { name: 'single char', text: 'a' },
    { name: 'one under cap (5999)', text: 'x'.repeat(5999) },
    { name: 'exactly at cap (6000)', text: 'x'.repeat(6000) },
    { name: 'one over cap (6001)', text: 'x'.repeat(6001) },
    { name: 'far over cap (12000)', text: 'y'.repeat(12000) },
    {
      name: 'multibyte straddling cap',
      // 4000 two-byte chars (UTF-8) + 4000 ASCII = 8000 UTF-16 code units.
      text: 'é'.repeat(4000) + 'z'.repeat(4000),
    },
  ];

  // ── (1) TRUNCATION: byte-identical to the legacy .cjs line-19 expression ────
  describe('capEmbedText === legacy truncate (line 19), byte-for-byte', () => {
    for (const { name, text } of FIXTURES) {
      it(`matches legacyTruncate for: ${name}`, () => {
        const inRepo = capEmbedText(text, 6000);
        const legacy = legacyTruncate(text);
        // Primary golden-diff: in-repo output === legacy output, exactly.
        expect(inRepo).toBe(legacy);

        if (text.length > 6000) {
          // Over-cap: result is the exact first-6000-char PREFIX of the input —
          // no ellipsis, marker, suffix, reorder, or mutation of retained chars.
          expect(inRepo).toBe(text.slice(0, 6000));
          expect(inRepo).toHaveLength(6000);
          // True-prefix invariant: input starts with the capped result.
          expect(text.startsWith(inRepo)).toBe(true);
        } else {
          // Under/at cap: identity pass-through (===, same reference content).
          expect(inRepo).toBe(text);
          expect(inRepo).toHaveLength(text.length);
        }
      });
    }

    it('pins the exact slice boundary: 6000 passes through, 6001 clamps to 6000', () => {
      // length 6000 -> unchanged (length stays 6000)
      const atLimit = capEmbedText('x'.repeat(6000), 6000);
      expect(atLimit).toHaveLength(6000);
      expect(atLimit).toBe('x'.repeat(6000));
      // length 6001 -> clamped to exactly 6000 (strict `>` comparison; the
      // char at index 6000 is excluded). This is the off-by-one gap closer.
      const overByOne = capEmbedText('x'.repeat(6001), 6000);
      expect(overByOne).toHaveLength(6000);
      expect(overByOne).toBe('x'.repeat(6000));
      // And it equals the legacy expression on this exact boundary case too.
      expect(overByOne).toBe(legacyTruncate('x'.repeat(6001)));
    });

    it('multibyte slice is by .length (UTF-16 units), matching legacy .slice', () => {
      // 8000 UTF-16 code units -> sliced to first 6000 code units. capEmbedText
      // and the legacy expression both slice by .length, so a half-cut surrogate
      // /accented region is treated identically (the equivalence target).
      const text = 'é'.repeat(4000) + 'z'.repeat(4000); // length 8000
      expect(text).toHaveLength(8000);
      const inRepo = capEmbedText(text, 6000);
      expect(inRepo).toBe(legacyTruncate(text));
      expect(inRepo).toHaveLength(6000);
      expect(inRepo).toBe(text.slice(0, 6000)); // first 4000 'é' + 2000 'z'
    });
  });

  // ── (2) MODEL-AWARE CAP: 6000 == legacy on the legacy model; 8000 in-repo ──
  // Forward-ported from waggle-os monorepo (mono-parity 2026-06-12): the *-8k
  // branch was reduced 24000 → 8000 — probe finding: '-8k' names can be
  // architecture-capped at 2048 tokens (nomic-bert), so a 24K-char cap sent
  // every long frame down the mock-fallback path.
  describe('maxEmbedCharsForModel: 6000 (legacy parity) vs 8000 (in-repo superset)', () => {
    it('returns 6000 for ordinary models — identical to legacy hardcoded MAX_CHARS', () => {
      // nomic-embed-text is THE legacy model (OLLAMA_MODEL default in the .cjs).
      // On this model the in-repo effective cap === the legacy 6000 constant.
      expect(maxEmbedCharsForModel('nomic-embed-text')).toBe(6000);
      expect(maxEmbedCharsForModel('nomic-embed-text')).toBe(LEGACY_MAX_CHARS);
      expect(maxEmbedCharsForModel('voyage-3-lite')).toBe(6000);
      expect(maxEmbedCharsForModel('deterministic-mock')).toBe(6000);
      expect(maxEmbedCharsForModel('text-embedding-3-small')).toBe(6000);
    });

    it('DOCUMENTED DELTA (model-aware cap): returns 8000 for *-8k / num_ctx 8192 — pure in-repo superset, no legacy analogue', () => {
      expect(maxEmbedCharsForModel('nomic-embed-text-8k')).toBe(8000);
      expect(maxEmbedCharsForModel('custom (num_ctx 8192)')).toBe(8000);
      // The 8000 branch does NOT exist in the .cjs (which hardcodes 6000
      // unconditionally), so it is asserted as an intentional divergence, not
      // diffed against legacy.
      expect(maxEmbedCharsForModel('nomic-embed-text-8k')).not.toBe(LEGACY_MAX_CHARS);
    });

    it('does NOT mistake an embedded "8k" substring for the *-8k variant', () => {
      // The regex requires a -/_/. delimiter before "8k" and a word boundary
      // after, so "model8kfoo" or "a8kb" must NOT trip the 8000 branch.
      expect(maxEmbedCharsForModel('model8kfoo')).toBe(6000);
      expect(maxEmbedCharsForModel('foo-8khz')).toBe(6000); // no \b after 8k
    });
  });

  // ── (3) mockEmbed: SELF-TEST only (no legacy analogue — documented delta) ────
  describe('mockEmbed self-test (in-repo-only; legacy .cjs has NO mock path)', () => {
    it('is deterministic: identical (text,dims) -> elementwise-identical vector', async () => {
      const provider = await createEmbeddingProvider({ provider: 'mock' });
      const a = await provider.embed('deterministic input');
      const b = await provider.embed('deterministic input');
      expect(a).toHaveLength(1024);
      expect(b).toHaveLength(1024);
      for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
    });

    it('pins the exact value formula arr[i] = (utf8byte[i]-128)/128 with trailing zeros', async () => {
      const provider = await createEmbeddingProvider({ provider: 'mock', targetDimensions: 64 });
      const text = 'Hello, 世界'; // ASCII + multibyte, byteLen > charLen, < dims
      const vec = await provider.embed(text);
      const expected = expectedMockEmbed(text, 64);
      expect(vec).toHaveLength(64);
      for (let i = 0; i < 64; i++) expect(vec[i]).toBe(expected[i]);
      // Spot-check the formula directly on a known byte: 'H' = 0x48 = 72.
      expect(vec[0]).toBe((72 - 128) / 128);
      // Trailing indices past the byte length stay exactly 0.
      const byteLen = new TextEncoder().encode(text).length;
      for (let i = byteLen; i < 64; i++) expect(vec[i]).toBe(0);
    });

    it('empty string -> all-zeros vector of length dims (loop body never runs)', async () => {
      const provider = await createEmbeddingProvider({ provider: 'mock', targetDimensions: 128 });
      const vec = await provider.embed('');
      expect(vec).toHaveLength(128);
      expect(Array.from(vec).every((v) => v === 0)).toBe(true);
    });

    it('is NOT L2-normalized (raw byte hash, intentionally un-normalized)', async () => {
      const provider = await createEmbeddingProvider({ provider: 'mock', targetDimensions: 32 });
      const vec = await provider.embed('abcdef'); // several non-zero components
      let sumSq = 0;
      for (const v of vec) sumSq += v * v;
      // A normalized vector would have sumSq === 1. A raw byte hash does not.
      expect(Math.abs(sumSq - 1)).toBeGreaterThan(1e-6);
    });

    it('respects targetDimensions on every path (vector length === configured dims)', async () => {
      const provider = await createEmbeddingProvider({ provider: 'mock', targetDimensions: 512 });
      expect(provider.dimensions).toBe(512);
      expect(await provider.embed('hello')).toHaveLength(512);
      const batch = await provider.embedBatch(['a', 'b', 'c']);
      expect(batch).toHaveLength(3);
      for (const v of batch) expect(v).toHaveLength(512);
    });
  });

  // ── (4) PER-TEXT FALLBACK: in-repo-only fix; legacy skips, never mocks ───────
  describe('reembedPerText degrades ONLY the failing input (in-repo fix; documented delta vs legacy skip)', () => {
    const DIMS = 8;
    // A deterministic fake Embedder: embed() throws for 'POISON' only and
    // returns a "real" marker vector otherwise (v[0] === t.length, which the
    // mock can never produce for these lengths). embedBatch() ALWAYS throws so
    // any batch caller is forced down the per-text recovery path.
    const realMarker = (t: string): Float32Array => {
      const v = new Float32Array(DIMS);
      v[0] = t.length;
      return v;
    };
    const fakeEmbedder: Embedder = {
      dimensions: DIMS,
      async embed(t: string) {
        if (t === 'POISON') throw new Error('backend rejected this input');
        return realMarker(t);
      },
      async embedBatch() {
        throw new Error('batch path intentionally fails in this test');
      },
    };

    it('keeps good inputs REAL and degrades only the failing one to mockEmbed', async () => {
      const texts = ['g1', 'POISON', 'g2', 'g3'];
      const out = await reembedPerText(fakeEmbedder, texts, DIMS);
      expect(out).toHaveLength(4);
      // Ordering preserved: output[i] corresponds to input[i].
      expect(out[0][0]).toBe(2); // 'g1' -> real (length 2)
      expect(out[2][0]).toBe(2); // 'g2' -> real
      expect(out[3][0]).toBe(2); // 'g3' -> real
      // 'POISON' -> exactly mockEmbed('POISON', DIMS), NOT a real length-6 vec.
      const expectedMock = expectedMockEmbed('POISON', DIMS);
      for (let i = 0; i < DIMS; i++) expect(out[1][i]).toBe(expectedMock[i]);
      // It is genuinely the mock (would be 6 if it were the real marker).
      expect(out[1][0]).not.toBe(6);
    });

    it('no good input is ever replaced by a mock because a sibling failed', async () => {
      // Two poisons among good inputs — every good input must still be real.
      const texts = ['ok', 'POISON', 'okay', 'POISON', 'okayy'];
      const out = await reembedPerText(fakeEmbedder, texts, DIMS);
      expect(out[0][0]).toBe(2);
      expect(out[2][0]).toBe(4);
      expect(out[4][0]).toBe(5);
      // The poisons degrade independently.
      const expectedMock = expectedMockEmbed('POISON', DIMS);
      for (const idx of [1, 3]) {
        for (let i = 0; i < DIMS; i++) expect(out[idx][i]).toBe(expectedMock[i]);
      }
    });

    it('the over-long text is embedded from its CAPPED prefix (caller caps first)', async () => {
      // Mirrors embedBatch()'s contract: callers cap inputs BEFORE reembedPerText.
      const capped = capEmbedText('w'.repeat(7000), 6000); // length 6000
      const out = await reembedPerText(fakeEmbedder, [capped], DIMS);
      expect(out).toHaveLength(1);
      // 'w'*6000 is not POISON -> real marker holds the CAPPED length, not 7000.
      expect(out[0][0]).toBe(6000);
    });

    it('DOCUMENTED DELTA: legacy would SKIP the failing frame (failed++), not mock it', () => {
      // The .cjs catch block does `failed++; console.error(...)` and inserts
      // NOTHING for the failing frame (leaves it un-embedded). There is no mock
      // path to diff against. We assert the in-repo behaviour (mock the single
      // failure) is the deliberate divergence by simulating the legacy outcome:
      const legacyResult: { ok: number; failed: number; vectors: (Float32Array | null)[] } = {
        ok: 0,
        failed: 0,
        vectors: [],
      };
      for (const t of ['g1', 'POISON', 'g2']) {
        if (t === 'POISON') {
          legacyResult.failed++;
          legacyResult.vectors.push(null); // skipped — left un-embedded
        } else {
          legacyResult.ok++;
          legacyResult.vectors.push(realMarker(t));
        }
      }
      // Legacy: the failing frame has NO vector (null), in-repo: it has a mock.
      expect(legacyResult.failed).toBe(1);
      expect(legacyResult.vectors[1]).toBeNull();
      // In-repo never leaves a null — it always returns a Float32Array.
      // (asserted in the per-text tests above; the divergence is intentional).
    });
  });

  // ── (5) WIRING: embed()/embedBatch() cap before delegating + empty batch ────
  describe('embed()/embedBatch() wiring through the public factory', () => {
    it('embed() applies the cap before hashing — returned vec == mockEmbed(prefix)', async () => {
      // Active provider is mock (deterministic-mock => cap 6000). An over-long
      // input must be capped to its 6000-char prefix BEFORE being hashed, so the
      // returned vector equals mockEmbed(input.slice(0,6000)). This proves the
      // cap reaches the embedder, not just that capEmbedText exists in isolation.
      const provider = await createEmbeddingProvider({ provider: 'mock', targetDimensions: 256 });
      const longInput = 'A'.repeat(7000); // 'A' = 0x41 = 65 byte
      const vec = await provider.embed(longInput);
      const cap = maxEmbedCharsForModel('deterministic-mock'); // 6000
      const expected = expectedMockEmbed(longInput.slice(0, cap), 256);
      expect(vec).toHaveLength(256);
      for (let i = 0; i < 256; i++) expect(vec[i]).toBe(expected[i]);
      // Sanity: the first `cap` bytes are all 'A', so the first 256 components
      // are all (65-128)/128; nothing past the prefix leaked in.
      for (let i = 0; i < 256; i++) expect(vec[i]).toBe((65 - 128) / 128);
    });

    it('embedBatch() caps EVERY element independently before delegating', async () => {
      const provider = await createEmbeddingProvider({ provider: 'mock', targetDimensions: 128 });
      const cap = 6000;
      const inputs = ['B'.repeat(9000), 'short', 'C'.repeat(6001)];
      const out = await provider.embedBatch(inputs);
      expect(out).toHaveLength(3);
      // output[i] corresponds to input[i], each capped independently.
      const exp0 = expectedMockEmbed('B'.repeat(cap), 128);
      const exp1 = expectedMockEmbed('short', 128);
      const exp2 = expectedMockEmbed('C'.repeat(cap), 128);
      for (let i = 0; i < 128; i++) {
        expect(out[0][i]).toBe(exp0[i]);
        expect(out[1][i]).toBe(exp1[i]);
        expect(out[2][i]).toBe(exp2[i]);
      }
    });

    it('embedBatch([]) returns [] (no provider call, short-circuit invariant)', async () => {
      const provider = await createEmbeddingProvider({ provider: 'mock' });
      expect(await provider.embedBatch([])).toEqual([]);
    });

    it('every returned vector is Float32Array of length === configured dims', async () => {
      const provider = await createEmbeddingProvider({ provider: 'mock', targetDimensions: 1024 });
      const single = await provider.embed('hello');
      expect(single).toBeInstanceOf(Float32Array);
      expect(single).toHaveLength(1024);
      const batch = await provider.embedBatch(['a', 'b']);
      for (const v of batch) {
        expect(v).toBeInstanceOf(Float32Array);
        expect(v).toHaveLength(1024);
      }
    });
  });

  // ── (6) DIM-FIT: documented delta — observable "length===target" property ───
  describe('DOCUMENTED DELTA: legacy fitDim vs in-repo (fit lives in the embedder layer)', () => {
    it('legacy fitDim always yields target length (the observable property in-repo also guarantees)', () => {
      // Legacy fitDim pads-or-truncates the model's native dim to TARGET_DIM.
      // In-repo has NO direct analogue — each concrete embedder is handed
      // targetDimensions and returns length===dims itself. We assert only the
      // OBSERVABLE shared property (length === target), not a code-level diff.
      expect(legacyFitDim(new Array(1023).fill(1), 1024)).toHaveLength(1024); // padded
      expect(legacyFitDim(new Array(1024).fill(1), 1024)).toHaveLength(1024); // identity
      expect(legacyFitDim(new Array(1025).fill(1), 1024)).toHaveLength(1024); // truncated
      // Padding fills with zeros at the tail.
      const padded = legacyFitDim([1, 2, 3], 5);
      expect(padded).toEqual([1, 2, 3, 0, 0]);
    });

    it('in-repo mock embedder independently guarantees length===targetDimensions', async () => {
      for (const dims of [256, 1024]) {
        const provider = await createEmbeddingProvider({ provider: 'mock', targetDimensions: dims });
        expect(await provider.embed('x')).toHaveLength(dims);
      }
    });
  });

  // ── (7) DOCUMENTED DELTA: provider abstraction (legacy = Ollama-only) ───────
  describe('DOCUMENTED DELTA: provider-agnostic vs legacy Ollama-hardwired', () => {
    it('truncation+fallback contract holds on the mock provider with no Ollama present', async () => {
      // The legacy .cjs POSTs to Ollama /api/embeddings unconditionally. In-repo
      // the same truncation + per-text-fallback contract is satisfied with NO
      // network and NO Ollama — proving provider independence of the surface.
      const provider = await createEmbeddingProvider({ provider: 'mock' });
      expect(provider.getActiveProvider()).toBe('mock');
      const out = await provider.embedBatch(['z'.repeat(6001), 'ok']);
      expect(out[0]).toHaveLength(1024); // capped + embedded, no network
      expect(out[1]).toHaveLength(1024);
    });
  });
});

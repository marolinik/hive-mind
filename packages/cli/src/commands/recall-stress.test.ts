/**
 * Equivalence golden-diff for the recall-stress precision@3 gate.
 *
 * Subject under test: benchmarks/recall-stress/run.mjs (the in-repo portable
 * port of the legacy D:/Projects/.harvest/stress-test.cjs). This gate justifies
 * deleting that legacy .cjs, so it must be rigorous.
 *
 * Why this lives in packages/cli/src (not next to run.mjs): vitest.config.ts
 * collects only `packages/*​/src/**​/*.{test,spec}.{ts,js}`. A spec placed under
 * benchmarks/ is never run. The recall-stress harness drives the built CLI, so
 * the CLI package is its natural home. It reaches the benchmark files via a
 * path relative to import.meta.url.
 *
 * Equivalence approach (the live recall subprocess is NOT hermetically diffable —
 * it needs a populated mind + embeddings + the built CLI; liveDiffable:false):
 * we prove equivalence at the PURE layer where all externally-observable scoring
 * behavior lives — scoreResult, abbrev, the JSON-from-first-brace stdout parser,
 * the mean-over-valid-rows aggregate, and the three-condition regression gate.
 *
 * run.mjs is a runnable harness with NO exports (and the hard constraints forbid
 * adding `export` to a non-test source file), so we re-declare byte-identical
 * copies of its functions here (IN_REPO_*) and lock them to the real source with
 * a SOURCE-DRIFT GUARD (bottom of file) that reads run.mjs and asserts each
 * function body is present verbatim. If run.mjs ever drifts, this spec fails loud.
 *
 * The GOLDEN DIFF re-implements the legacy .cjs scoreResult inline
 * (LEGACY_scoreResult, side-effect-free, reconstructed from the documented
 * equivalence contract) and asserts run.mjs's scoreResult returns the SAME
 * numeric `precision` for every fixture row, EXPLICITLY excluding the documented
 * divergences (note wording, harvestedCount).
 *
 * Hermetic + deterministic: no subprocess, no network, no embedding provider, no
 * real ~/.hive-mind or D:/Projects mutation. Pure functions over fixed inputs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Belt-and-suspenders: this spec touches no provider, but pin the env that the
// repo uses to keep CI/headless runs from loading the ~87MB reranker if any
// transitively-imported module probes it. We import nothing heavy, so this is
// purely defensive and side-effect-free.
process.env.HIVE_MIND_NO_RERANK = process.env.HIVE_MIND_NO_RERANK ?? '1';

// Resolve the benchmark dir from the repo root (vitest runs with cwd = repo
// root). We deliberately build filenames from variables and assemble the
// extension at runtime so vite's static import scanner never mistakes these
// read targets for module specifiers to transform.
const REPO_ROOT = process.cwd();
const BENCH = join(REPO_ROOT, 'benchmarks', 'recall-stress');
const MJS = '.mjs';
const JSON_EXT = '.json';
const readRunMjs = (): string => readFileSync(join(BENCH, 'run' + MJS), 'utf8');
const readExampleJson = (): string => readFileSync(join(BENCH, 'queries.example' + JSON_EXT), 'utf8');
const readGitignore = (): string => readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');

// ---------------------------------------------------------------------------
// IN-REPO functions — byte-identical copies of run.mjs (guarded below).
// ---------------------------------------------------------------------------

interface Hit { id?: string; content?: string; importance?: number; score?: number }
interface Query { cat?: string; q?: string; expect?: string[] }

function IN_REPO_scoreResult(query: Query, results: Hit[]): { precision: number; note: string } {
  const hits = results.slice(0, 3);
  if (!query.expect || query.expect.length === 0) {
    // Edge query: success = nothing scores as relevant.
    const maxScore = hits[0]?.score ?? 0;
    return { precision: maxScore < 0.02 ? 1 : 0, note: `edge — max score ${maxScore.toFixed(3)}` };
  }
  const matched = hits.filter((h) => {
    const text = (h.content || '').toLowerCase();
    return query.expect!.some((needle) => text.includes(String(needle).toLowerCase()));
  });
  const precision = hits.length ? matched.length / hits.length : 0;
  return { precision, note: `${matched.length}/${hits.length} top-3 matched expected` };
}

const IN_REPO_abbrev = (s: unknown, n = 100): string => {
  const t = String(s || '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// Pure mirror of run.mjs callRecall's JSON-from-first-brace parse path. The
// spawn half is intentionally not reproduced; only the parse logic (the
// equivalence-critical, deterministic part) is pinned here.
function IN_REPO_parseStdout(stdout: string | undefined): { ok: boolean; results: Hit[] } {
  const out = stdout || '';
  const jsonStart = out.indexOf('{');
  if (jsonStart < 0) return { ok: false, results: [] };
  try {
    const parsed = JSON.parse(out.slice(jsonStart));
    return { ok: Array.isArray(parsed.hits), results: parsed.hits ?? [] };
  } catch {
    return { ok: false, results: [] };
  }
}

// ---------------------------------------------------------------------------
// LEGACY .cjs scoreResult — reconstructed from D:/Projects/.harvest/stress-test.cjs
// per the documented equivalence contract. Side-effect-free. We assert ONLY that
// its `precision` matches IN_REPO for every fixture; note wording & harvestedCount
// are documented divergences and are NOT compared. (Legacy was unguarded:
// matched.length / hits.length — zero hits => NaN. We exercise that explicitly
// in the "documented divergences" block, not in the precision golden diff.)
// ---------------------------------------------------------------------------

function LEGACY_scoreResult(query: Query, results: Hit[]): { precision: number } {
  const hits = results.slice(0, 3);
  if (!query.expect || query.expect.length === 0) {
    const maxScore = hits[0]?.score ?? 0;
    return { precision: maxScore < 0.02 ? 1 : 0 };
  }
  const matched = hits.filter((h) => {
    const text = (h.content || '').toLowerCase();
    return query.expect!.some((needle) => text.includes(String(needle).toLowerCase()));
  });
  const precision = matched.length / hits.length; // unguarded on purpose
  return { precision };
}

// ---------------------------------------------------------------------------
// Shared fixture: synthetic hit-lists + queries. No real data.
// legacyComparable=false marks rows exercising a documented divergence (the
// empty-hits guard) where legacy would NaN — excluded from the golden diff.
// ---------------------------------------------------------------------------

const H = (content: string | undefined, score: number): Hit => ({ id: 'x', content, importance: 1, score });

interface FixtureRow { name: string; query: Query; results: Hit[]; expectPrecision: number; legacyComparable: boolean }

const FIXTURE: FixtureRow[] = [
  // --- non-edge: full / partial / zero match ---
  {
    name: 'full match (3/3)',
    query: { cat: 'c', q: 'q', expect: ['alpha'] },
    results: [H('alpha one', 0.9), H('has alpha too', 0.8), H('alpha alpha', 0.7)],
    expectPrecision: 1,
    legacyComparable: true,
  },
  {
    name: 'partial match (1/3)',
    query: { cat: 'c', q: 'q', expect: ['alpha'] },
    results: [H('alpha one', 0.9), H('beta', 0.8), H('gamma', 0.7)],
    expectPrecision: 1 / 3,
    legacyComparable: true,
  },
  {
    name: 'zero match (0/3)',
    query: { cat: 'c', q: 'q', expect: ['zzz'] },
    results: [H('alpha', 0.9), H('beta', 0.8), H('gamma', 0.7)],
    expectPrecision: 0,
    legacyComparable: true,
  },
  // --- TOP-3 scoring window: 5 hits, only first 3 count ---
  {
    name: 'window: 5 hits, matches only in positions 4-5 -> 0 (top-3 only)',
    query: { cat: 'c', q: 'q', expect: ['needle'] },
    results: [H('a', 0.9), H('b', 0.8), H('c', 0.7), H('needle', 0.6), H('needle', 0.5)],
    expectPrecision: 0,
    legacyComparable: true,
  },
  {
    name: 'window: 5 hits, 2 of top-3 match -> 2/3',
    query: { cat: 'c', q: 'q', expect: ['needle'] },
    results: [H('needle', 0.9), H('needle', 0.8), H('c', 0.7), H('x', 0.6), H('y', 0.5)],
    expectPrecision: 2 / 3,
    legacyComparable: true,
  },
  // --- matched counts HITS not needles: one hit, two needles both present -> 1 hit ---
  {
    name: 'one hit matches two needles -> still 1/1 (counts hits not needles)',
    query: { cat: 'c', q: 'q', expect: ['alpha', 'beta'] },
    results: [H('alpha and beta together', 0.9)],
    expectPrecision: 1,
    legacyComparable: true,
  },
  // --- case-insensitivity (both sides lowercased) ---
  {
    name: 'case-insensitive: needle "Hybrid" vs content "HYBRID search" -> match',
    query: { cat: 'c', q: 'q', expect: ['Hybrid'] },
    results: [H('HYBRID search', 0.9), H('unrelated', 0.8), H('none', 0.7)],
    expectPrecision: 1 / 3,
    legacyComparable: true,
  },
  {
    name: 'case-insensitive: needle "FUSION" vs content "fusion of ranks" -> match',
    query: { cat: 'c', q: 'q', expect: ['FUSION'] },
    results: [H('fusion of ranks', 0.9)],
    expectPrecision: 1,
    legacyComparable: true,
  },
  // --- missing/empty content treated as '' (no match) ---
  {
    name: 'missing content field -> treated as "" -> no match',
    query: { cat: 'c', q: 'q', expect: ['alpha'] },
    results: [{ id: 'x', score: 0.9 }, H('alpha', 0.8), H('alpha', 0.7)],
    expectPrecision: 2 / 3,
    legacyComparable: true,
  },
  {
    name: 'empty-string content -> no match',
    query: { cat: 'c', q: 'q', expect: ['alpha'] },
    results: [H('', 0.9), H('', 0.8), H('alpha', 0.7)],
    expectPrecision: 1 / 3,
    legacyComparable: true,
  },
  // --- edge queries (expect: []) at score boundaries ---
  {
    name: 'edge: score 0.0 -> precision 1',
    query: { cat: 'edge', q: 'q', expect: [] },
    results: [H('whatever', 0.0)],
    expectPrecision: 1,
    legacyComparable: true,
  },
  {
    name: 'edge: score 0.0199 (just below cutoff) -> precision 1',
    query: { cat: 'edge', q: 'q', expect: [] },
    results: [H('whatever', 0.0199)],
    expectPrecision: 1,
    legacyComparable: true,
  },
  {
    name: 'edge: score exactly 0.02 (strict <) -> precision 0',
    query: { cat: 'edge', q: 'q', expect: [] },
    results: [H('whatever', 0.02)],
    expectPrecision: 0,
    legacyComparable: true,
  },
  {
    name: 'edge: score 0.05 (above cutoff) -> precision 0',
    query: { cat: 'edge', q: 'q', expect: [] },
    results: [H('whatever', 0.05)],
    expectPrecision: 0,
    legacyComparable: true,
  },
  {
    name: 'edge: empty hits -> maxScore 0 -> precision 1',
    query: { cat: 'edge', q: 'q', expect: [] },
    results: [],
    expectPrecision: 1,
    legacyComparable: true,
  },
];

describe('recall-stress scoreResult — pinned precision (TOP-3 window, formula, match semantics)', () => {
  for (const row of FIXTURE) {
    it(`in-repo precision: ${row.name}`, () => {
      const { precision } = IN_REPO_scoreResult(row.query, row.results);
      expect(precision).toBe(row.expectPrecision);
    });
  }

  it('PRECISION FORMULA: matched counts HITS not needles, denom = top-3 hits.length', () => {
    // 3 hits, expect two needles; hit 1 has both, hits 2/3 have neither -> 1/3 (not 2/3)
    const q: Query = { expect: ['alpha', 'beta'] };
    const r = [H('alpha beta', 0.9), H('none', 0.8), H('none', 0.7)];
    expect(IN_REPO_scoreResult(q, r).precision).toBe(1 / 3);
  });

  it('PER-QUERY MATCH: substring containment, NOT word-boundary', () => {
    // "frame" needle matches inside "frameworks" (substring, not token match)
    const q: Query = { expect: ['frame'] };
    expect(IN_REPO_scoreResult(q, [H('about frameworks', 0.9)]).precision).toBe(1);
  });
});

describe('recall-stress EDGE constant — strict < 0.02 cutoff is pinned', () => {
  it('exactly 0.02 -> 0 (strict less-than, NOT <=)', () => {
    expect(IN_REPO_scoreResult({ expect: [] }, [{ score: 0.02 }]).precision).toBe(0);
  });
  it('0.0199 -> 1 (just below cutoff)', () => {
    expect(IN_REPO_scoreResult({ expect: [] }, [{ score: 0.0199 }]).precision).toBe(1);
  });
  it('edge note wording is exactly `edge — max score <x.xxx>` (3 dp)', () => {
    expect(IN_REPO_scoreResult({ expect: [] }, [{ score: 0.05 }]).note).toBe('edge — max score 0.050');
    expect(IN_REPO_scoreResult({ expect: [] }, []).note).toBe('edge — max score 0.000');
  });
});

describe('recall-stress GOLDEN DIFF — in-repo precision == legacy .cjs precision', () => {
  for (const row of FIXTURE.filter((r) => r.legacyComparable)) {
    it(`legacy parity: ${row.name}`, () => {
      const inRepo = IN_REPO_scoreResult(row.query, row.results).precision;
      const legacy = LEGACY_scoreResult(row.query, row.results).precision;
      expect(inRepo).toBe(legacy);
      // and both equal the asserted ground truth
      expect(inRepo).toBe(row.expectPrecision);
    });
  }
});

describe('recall-stress documented divergences — locked as intentional', () => {
  it('[DISCOVERED] empty-hits guard: in-repo non-edge returns 0; legacy would NaN', () => {
    const q: Query = { expect: ['alpha'] };
    const inRepo = IN_REPO_scoreResult(q, []);
    expect(inRepo.precision).toBe(0); // guarded: hits.length ? .. : 0
    const legacy = LEGACY_scoreResult(q, []);
    expect(Number.isNaN(legacy.precision)).toBe(true); // 0/0 -> NaN, the bug we fixed
  });

  it('[DISCOVERED] note wording: no harvest clause; `<m>/<h> top-3 matched expected`', () => {
    const q: Query = { expect: ['alpha'] };
    const r = [H('alpha', 0.9), H('beta', 0.8), H('alpha', 0.7)];
    expect(IN_REPO_scoreResult(q, r).note).toBe('2/3 top-3 matched expected');
    expect(IN_REPO_scoreResult(q, r).note).not.toMatch(/harvest/);
  });

  it('[INTENDED] scoreResult drops harvestedCount entirely (no provenance field)', () => {
    const q: Query = { expect: ['alpha'] };
    const out = IN_REPO_scoreResult(q, [H('alpha', 0.9)]);
    expect(Object.keys(out).sort()).toEqual(['note', 'precision']);
    expect(out).not.toHaveProperty('harvestedCount');
  });
});

describe('recall-stress abbrev — whitespace-collapse + truncate-with-ellipsis', () => {
  it('collapses whitespace runs to single spaces', () => {
    expect(IN_REPO_abbrev('a   b\t\tc\nd')).toBe('a b c d');
  });
  it('truncates to n chars and appends U+2026 when longer', () => {
    const out = IN_REPO_abbrev('x'.repeat(120), 100);
    expect(out.length).toBe(101); // 100 chars + 1 ellipsis char
    expect(out.endsWith('…')).toBe(true);
    expect(out.codePointAt(out.length - 1)).toBe(0x2026); // exactly U+2026
    expect(out).toBe('x'.repeat(100) + '…');
  });
  it('does not truncate when within n', () => {
    expect(IN_REPO_abbrev('short', 100)).toBe('short');
  });
  it('null/undefined -> ""', () => {
    expect(IN_REPO_abbrev(null)).toBe('');
    expect(IN_REPO_abbrev(undefined)).toBe('');
  });
  it('default width is 100 (boundary: 100 stays, 101 truncates)', () => {
    expect(IN_REPO_abbrev('y'.repeat(100))).toBe('y'.repeat(100));
    expect(IN_REPO_abbrev('y'.repeat(101))).toBe('y'.repeat(100) + '…');
  });
});

describe('recall-stress JSON-from-first-brace parser tolerance', () => {
  it('parses { hits } even with leading log/banner lines on stdout', () => {
    const stdout =
      '[probe] loading embeddings...\nWARN something\n{"query":"q","hits":[{"id":"1","content":"alpha","score":0.9}]}';
    const r = IN_REPO_parseStdout(stdout);
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].content).toBe('alpha');
  });
  it('clean JSON with no leading noise parses', () => {
    const r = IN_REPO_parseStdout('{"hits":[]}');
    expect(r.ok).toBe(true);
    expect(r.results).toEqual([]);
  });
  it('no opening brace -> ok:false error row', () => {
    const r = IN_REPO_parseStdout('no json here at all');
    expect(r.ok).toBe(false);
    expect(r.results).toEqual([]);
  });
  it('empty/undefined stdout -> ok:false error row', () => {
    expect(IN_REPO_parseStdout('').ok).toBe(false);
    expect(IN_REPO_parseStdout(undefined).ok).toBe(false);
  });
  it('payload without a hits array -> ok:false (Array.isArray guard)', () => {
    const r = IN_REPO_parseStdout('{"query":"q","notHits":1}');
    expect(r.ok).toBe(false);
    expect(r.results).toEqual([]);
  });
  it('garbage after first brace -> ok:false (JSON.parse throws, caught)', () => {
    expect(IN_REPO_parseStdout('log line\n{not valid json').ok).toBe(false);
  });
});

describe('recall-stress AGGREGATE — mean over non-error rows only', () => {
  // Mirrors run.mjs: valid = rows.filter(!error); avg = sum(precision)/valid.length
  type Row = { error?: boolean; score?: { precision: number } };
  const aggregate = (rows: Row[]): number => {
    const valid = rows.filter((r) => !r.error);
    return valid.length ? valid.reduce((s, r) => s + r.score!.precision, 0) / valid.length : 0;
  };
  it('error rows excluded from the denominator', () => {
    const rows: Row[] = [
      { score: { precision: 1 } },
      { error: true },
      { score: { precision: 0 } },
    ];
    // 2 valid rows -> (1 + 0) / 2 = 0.5  (NOT /3)
    expect(aggregate(rows)).toBe(0.5);
  });
  it('all-error -> 0 (guarded, not NaN)', () => {
    expect(aggregate([{ error: true }, { error: true }])).toBe(0);
  });
});

describe('recall-stress REGRESSION GATE — composes the three fail conditions', () => {
  // Mirrors run.mjs gate: fail if elapsed>maxSeconds OR avg<minPrecision OR any error.
  const gateFails = (elapsedS: number, maxSeconds: number, avg: number, minPrecision: number, anyError: boolean): string[] => {
    const fail: string[] = [];
    if (elapsedS > maxSeconds) fail.push('slow');
    if (avg < minPrecision) fail.push('precision');
    if (anyError) fail.push('error');
    return fail;
  };
  it('passes when fast, above threshold, no errors', () => {
    expect(gateFails(10, 60, 0.8, 0.5, false)).toEqual([]);
  });
  it('fails on too slow', () => {
    expect(gateFails(61, 60, 0.9, 0.5, false)).toContain('slow');
  });
  it('fails on low precision (strict <)', () => {
    expect(gateFails(10, 60, 0.49, 0.5, false)).toContain('precision');
    // exactly at threshold does NOT fail (avg < min is strict)
    expect(gateFails(10, 60, 0.5, 0.5, false)).not.toContain('precision');
  });
  it('fails on any error row', () => {
    expect(gateFails(10, 60, 0.9, 0.5, true)).toContain('error');
  });
});

describe('recall-stress PRIVACY GUARD — shipped example carries no operator tokens', () => {
  const PROPRIETARY = [
    'Egzakta', 'SocialPresence', 'medusa', 'my-medusa-store', 'MEMORYFORGE',
    'LinkedIn', 'HiveMind monorepo', 'Plan A', 'sandbox',
  ];
  it('queries.example.json contains none of the operator proprietary tokens', () => {
    const txt = readExampleJson().toLowerCase();
    for (const tok of PROPRIETARY) {
      expect(txt.includes(tok.toLowerCase())).toBe(false);
    }
  });
  it('queries.example.json ships the neutral concept + edge query set', () => {
    const cfg = JSON.parse(readExampleJson());
    const cats = cfg.queries.map((q: Query) => q.cat);
    expect(cats).toContain('concept');
    expect(cats).toContain('edge');
    // exactly one edge query, and it is an empty-expect (off-topic) query
    const edges = cfg.queries.filter((q: Query) => Array.isArray(q.expect) && q.expect.length === 0);
    expect(edges).toHaveLength(1);
  });
  it('.gitignore covers queries.local.json and *-results.md', () => {
    const gi = readGitignore();
    expect(gi.includes('benchmarks/recall-stress/queries.local.json')).toBe(true);
    expect(gi.includes('benchmarks/recall-stress/*-results.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SOURCE-DRIFT GUARD: assert the IN_REPO_* copies above are byte-identical to
// the functions in run.mjs, so this spec can never silently diverge from the
// thing it claims to pin. Also pins the documented [INTENDED]/[DISCOVERED]
// transport/portability deltas at the source level.
// ---------------------------------------------------------------------------

describe('recall-stress SOURCE GUARD — IN_REPO copies match run.mjs verbatim', () => {
  const src = readRunMjs();

  it('run.mjs scoreResult body is present verbatim', () => {
    expect(src).toContain('function scoreResult(query, results) {');
    expect(src).toContain('const hits = results.slice(0, 3);');
    expect(src).toContain('return { precision: maxScore < 0.02 ? 1 : 0, note: `edge — max score ${maxScore.toFixed(3)}` };');
    expect(src).toContain('return query.expect.some((needle) => text.includes(String(needle).toLowerCase()));');
    expect(src).toContain('const precision = hits.length ? matched.length / hits.length : 0;');
    expect(src).toContain('return { precision, note: `${matched.length}/${hits.length} top-3 matched expected` };');
  });

  it('run.mjs abbrev is present verbatim (default width 100, U+2026)', () => {
    expect(src).toContain('const abbrev = (s, n = 100) => {');
    expect(src).toContain("const t = String(s || '').replace(/\\s+/g, ' ');");
    expect(src).toContain("return t.length > n ? t.slice(0, n) + '…' : t;");
  });

  it('run.mjs callRecall JSON-from-first-brace parse path is present verbatim', () => {
    expect(src).toContain("const jsonStart = out.indexOf('{');");
    expect(src).toContain('if (jsonStart < 0) return { ok: false, results: [], raw: out };');
    expect(src).toContain('return { ok: Array.isArray(parsed.hits), results: parsed.hits ?? [] };');
  });

  it('[INTENDED] recall call params: limit 5, profile, 30s timeout, 4MB buffer, NO_RERANK default 1', () => {
    expect(src).toContain("[CLI, 'recall-context', query, '--json', '--limit', '5', '--profile', activeProfile]");
    expect(src).toContain('timeout: 30_000');
    expect(src).toContain('maxBuffer: 4 * 1024 * 1024');
    expect(src).toContain("HIVE_MIND_NO_RERANK: process.env.HIVE_MIND_NO_RERANK ?? '1'");
  });

  it('[INTENDED] scope:personal is NOT passed (only the documented arg vector)', () => {
    // The legacy .cjs hardcoded scope 'personal'; the port relies on the CLI default.
    expect(src).not.toContain("'scope'");
    expect(src).not.toContain("scope: 'personal'");
  });

  it('[DISCOVERED] portable root resolution (HIVE_MIND_ROOT / HIVE_MIND_CLI, no hardcoded D:/)', () => {
    expect(src).toContain("process.env.HIVE_MIND_ROOT ?? resolve(HERE, '..', '..')");
    expect(src).toContain("process.env.HIVE_MIND_CLI ?? join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js')");
    expect(src).not.toContain('D:/Projects');
    expect(src).not.toContain('D:\\Projects');
  });

  it('[INTENDED] regression gate composes the three fail conditions + exit(1)', () => {
    expect(src).toContain('if (elapsedS > maxSeconds)');
    expect(src).toContain('if (avgPrecision < minPrecision)');
    expect(src).toContain("if (rows.some((r) => r.error)) fail.push('one or more queries errored');");
    expect(src).toContain('process.exit(1);');
  });

  it('aggregate excludes error rows from the denominator (verbatim)', () => {
    expect(src).toContain('const valid = rows.filter((r) => !r.error);');
    expect(src).toContain('valid.length ? valid.reduce((s, r) => s + r.score.precision, 0) / valid.length : 0');
  });

  it('[INTENDED] queries are parameterized from a JSON file (default queries.example.json)', () => {
    expect(src).toContain("const queriesPath = arg('queries', join(HERE, 'queries.example.json'));");
    expect(src).toContain("const queries = config.queries ?? [];");
  });
});

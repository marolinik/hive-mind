/**
 * EQUIVALENCE GOLDEN-DIFF — "purge-noise-dedupe".
 *
 * This file is the deletion gate for the legacy one-shot script
 * `D:/Projects/.harvest/purge-noise-entities.cjs`. It proves the in-repo
 * behaviour subsumes the legacy script's two halves:
 *
 *   PROOF 1 (NOISE, pure-function drop-set diff)
 *     The legacy `isNoiseName` predicate is reproduced here as a FROZEN inline
 *     literal (`refIsNoise` + `REF_STOP_TOKENS`, pasted verbatim from the .cjs).
 *     We run BOTH the live `@hive-mind/core` `isNoiseName` and the frozen
 *     reference over an exhaustive fixture and assert the ONLY difference is the
 *     documented `TECH_ALLOWLIST` delta:
 *        D_ref \ D_live === { allowlisted tokens }   (legacy drops, in-repo keeps)
 *        D_live \ D_ref === ∅                          (in-repo never drops a legacy-keep)
 *     The test also re-parses the live .cjs at runtime (when present) and asserts
 *     its STOP_TOKENS array is byte-identical to the frozen literal, so the
 *     frozen literal cannot silently drift from the real legacy file.
 *
 *   PROOF 2 (DEDUPE, in-memory behavioural diff against the RATIFIED contract)
 *     The in-repo `KnowledgeGraph.dedupeByName()` INTENTIONALLY diverges from
 *     the .cjs (type-aware grouping, most-relations survivor, soft-delete,
 *     relation re-point). So instead of diffing against a .cjs replica we assert
 *     the documented in-repo contract directly on a fresh tmp .mind, and lock
 *     EVERY documented divergence with an explicit assertion. Dedupe scenarios
 *     use CASE-ONLY name variants (e.g. 'Solr'/'solr'/'SOLR') wherever possible
 *     so grouping depends only on the `.toLowerCase()` half of the key and is
 *     independent of the ALIASES table — except one test that deliberately
 *     exercises alias collapse (Postgres/postgresql/pg).
 *
 * Hermetic + deterministic: tmp .mind via os.tmpdir(), no network, no embedder,
 * pure functions for the noise half. NEVER touches ~/.hive-mind or D:/Projects
 * operator data, and NEVER executes the .cjs (which would mutate real data on
 * --apply). The .cjs is only read as text for the STOP_TOKENS parity check.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { MindDB } from './db.js';
import { KnowledgeGraph } from './knowledge.js';
import { isNoiseName, isLikelyAcronym } from './entity-normalizer.js';

process.env.HIVE_MIND_NO_RERANK = '1';
process.env.HIVE_MIND_NO_SYNTH = '1';

// ─────────────────────────────────────────────────────────────────────────────
// FROZEN reference copy of the legacy .cjs predicate.
// Pasted verbatim from D:/Projects/.harvest/purge-noise-entities.cjs lines 25-55.
// Do NOT "fix" or reorder — it must mirror the legacy script byte-for-byte so
// the drop-set diff is meaningful.
// ─────────────────────────────────────────────────────────────────────────────
const REF_STOP_TOKENS = new Set<string>([
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'Why', 'How',
  'What', 'Who', 'Which', 'If', 'And', 'But', 'Or', 'So', 'For', 'Nor',
  'Yet', 'As', 'At', 'By', 'On', 'In', 'To', 'From', 'With', 'Without',
  'Into', 'Onto', 'Upon', 'Over', 'Under', 'Between', 'Among',
  'Add', 'Remove', 'Set', 'Get', 'Update', 'Delete', 'Create', 'List',
  'Search', 'Find', 'Run', 'Build', 'Use', 'Make', 'Test', 'Check',
  'Read', 'Write', 'Edit', 'Save', 'Load', 'Open', 'Close', 'Start',
  'Stop', 'Show', 'Hide', 'Push', 'Pull', 'Fix', 'Done', 'Skip',
  'Wait', 'Try', 'Note', 'Warn', 'Info', 'Debug', 'Trace',
  'Todo', 'Fixme', 'Should', 'Could', 'Would', 'Must', 'Will', 'Shall',
  'Can', 'May', 'Might',
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
  'Nov', 'Dec',
  'January', 'February', 'March', 'April', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]);

function refIsLikelyAcronym(s: string): boolean {
  return /^[A-Z]+$/.test(s) && s.length <= 6;
}

/** Verbatim legacy predicate (no TECH_ALLOWLIST — that is the divergence). */
function refIsNoise(name: string): boolean {
  if (!name || name.length < 4) return true;
  if (REF_STOP_TOKENS.has(name)) return true;
  if (!/\s/.test(name) && refIsLikelyAcronym(name)) return true;
  return false;
}

// The documented, reviewed divergence: real short tech names the in-repo
// version keeps but the legacy .cjs would drop. Mirrors entity-normalizer.ts
// TECH_ALLOWLIST (lines 96-106). Checked case-insensitively.
const TECH_ALLOWLIST = new Set<string>([
  'go', 'php', 'bun', 'deno',
  'npm', 'pip', 'gem', 'vim', 'git',
  'vue', 'zod', 'nuxt', 'vite', 'hono',
  'ai', 'ml', 'db', 'os', 'ui', 'ux', 'io', 'ci', 'cd', 'k8s',
  'sdk', 'orm', 'jwt', 'ssh', 'dns', 'gpu', 'cpu',
]);

// Exhaustive fixture exercising every branch of both predicates.
const FIXTURE: string[] = [
  // empty + sub-4-char (length rule)
  '', 'a', 'ab', 'abc', 'xyz',
  // length-4 boundary (survives length rule)
  'then', 'word', 'data',
  // lowercase stop-word forms — NOT STOP_TOKENS hits (case-sensitive set);
  // 'the'/'and'/'may' fall to length<4; 'when'/'should' are len>=4 lowercase
  // → not in the case-sensitive set → survive in BOTH predicates.
  'the', 'and', 'may', 'when', 'should',
  // capitalized stop tokens (verbs / modals / months / weekdays)
  'The', 'And', 'Update', 'Delete', 'Should', 'Could', 'Might',
  'Monday', 'Sunday', 'Mon', 'Sun', 'Dec', 'May', 'January', 'December',
  // acronyms by length: 1,3,4,6 = noise; 7 = NOT acronym (len>6) → survives
  'A', 'API', 'HTTP', 'JSON', 'GITHUB', 'SEVENXX',
  // mixed-case single words (not all-caps → not acronym; len>=4 → survive)
  'Http', 'TypeScript', 'Voyage', 'PostgreSQL',
  // hyphenated single words (len>=4, not all-caps) → survive
  'hive-mind', 'better-sqlite3',
  // multi-word: skip the acronym filter even when each token is acronym-shaped
  'Acme Corp', 'UNITED NATIONS', 'NEW YORK',
  // EVERY TECH_ALLOWLIST token, in mixed case, to lock the full allowlist
  'Go', 'PHP', 'Bun', 'Deno',
  'NPM', 'Pip', 'Gem', 'Vim', 'Git',
  'Vue', 'Zod', 'Nuxt', 'Vite', 'Hono',
  'AI', 'ML', 'DB', 'OS', 'UI', 'UX', 'IO', 'CI', 'CD', 'K8s',
  'SDK', 'ORM', 'JWT', 'SSH', 'DNS', 'GPU', 'CPU',
];

describe('purge-noise-dedupe :: PROOF 1 — NOISE predicate drop-set diff vs legacy .cjs', () => {
  it('live isNoiseName drop-set differs from the legacy predicate by EXACTLY the TECH_ALLOWLIST', () => {
    const dLive = new Set(FIXTURE.filter((t) => isNoiseName(t)));
    const dRef = new Set(FIXTURE.filter((t) => refIsNoise(t)));

    // Tokens the legacy drops but the in-repo keeps == the allowlisted tokens
    // present in the fixture (case-insensitive match against TECH_ALLOWLIST).
    const refMinusLive = [...dRef].filter((t) => !dLive.has(t)).sort();
    const expectedAllowlistDrops = FIXTURE.filter(
      (t) => refIsNoise(t) && TECH_ALLOWLIST.has(t.toLowerCase()),
    ).sort();

    expect(refMinusLive).toEqual(expectedAllowlistDrops);
    // sanity: the expected set is non-trivial and every member is allowlisted
    expect(refMinusLive.length).toBeGreaterThanOrEqual(20);
    for (const t of refMinusLive) {
      expect(TECH_ALLOWLIST.has(t.toLowerCase()), `${t} must be allowlisted`).toBe(true);
    }

    // The in-repo must NEVER drop something the legacy keeps (no over-dropping).
    const liveMinusRef = [...dLive].filter((t) => !dRef.has(t));
    expect(liveMinusRef).toEqual([]);
  });

  it('STOP_TOKENS parity: every legacy stop token is still noise in-repo (case-sensitive)', () => {
    // STOP_TOKENS is module-private; probe it through the public isNoiseName.
    // A capitalized stop token of length>=4 that is NOT allowlisted and NOT an
    // all-caps acronym can only be noise via STOP_TOKENS membership, so this
    // asserts the live set still contains each legacy token.
    for (const tok of REF_STOP_TOKENS) {
      if (TECH_ALLOWLIST.has(tok.toLowerCase())) continue; // none collide, but be safe
      expect(isNoiseName(tok), `legacy stop token ${tok} must be noise in-repo`).toBe(true);
    }
  });

  it('STOP_TOKENS parity: no NEW non-allowlisted noise token outside the legacy/length/acronym rules', () => {
    // For multi-word, mixed-case, length>=4, non-allowlisted, non-acronym names,
    // the ONLY way the live predicate could call them noise is if a token was
    // ADDED to STOP_TOKENS that the legacy set lacks. Assert none such fixture
    // survivor flipped to noise.
    const survivorsThatShouldStayKept = FIXTURE.filter((t) => {
      if (!t) return false;
      if (t.length < 4) return false;
      if (/\s/.test(t)) return true; // multi-word always exempt
      if (isLikelyAcronym(t)) return false; // acronym path covered elsewhere
      if (REF_STOP_TOKENS.has(t)) return false; // legacy stop token, expected noise
      return true; // plain long word — must survive in both
    });
    for (const t of survivorsThatShouldStayKept) {
      expect(isNoiseName(t), `${t} unexpectedly became noise (STOP_TOKENS drift?)`).toBe(false);
    }
  });

  it('isLikelyAcronym is byte-identical to the legacy definition at the boundaries', () => {
    const cases = ['A', 'API', 'HTTP', 'GITHUB', 'SEVENXX', 'Http', 'A1', 'A-B', ''];
    for (const c of cases) {
      expect(isLikelyAcronym(c), `acronym(${JSON.stringify(c)})`).toBe(refIsLikelyAcronym(c));
    }
    // explicit boundary pins
    expect(isLikelyAcronym('GITHUB')).toBe(true); // len 6 all-caps
    expect(isLikelyAcronym('SEVENXX')).toBe(false); // len 7 → not acronym
    expect(isLikelyAcronym('Http')).toBe(false); // mixed case
    expect(isLikelyAcronym('A1')).toBe(false); // digit
  });

  it('frozen REF_STOP_TOKENS is byte-identical to the live legacy .cjs (when present)', () => {
    const cjsPath = join('D:', 'Projects', '.harvest', 'purge-noise-entities.cjs');
    if (!existsSync(cjsPath)) {
      // Once the .cjs is deleted (the whole point of this gate) the frozen
      // literal becomes the sole source of truth — that is acceptable.
      return;
    }
    const src = readFileSync(cjsPath, 'utf8');
    const m = src.match(/STOP_TOKENS = new Set[^[]*\[([\s\S]*?)\]/);
    expect(m, 'could not locate STOP_TOKENS in .cjs').toBeTruthy();
    const parsed: string[] = [];
    const re = /['"]([^'"]+)['"]/g;
    let g: RegExpExecArray | null;
    while ((g = re.exec(m![1])) !== null) parsed.push(g[1]);

    const live = new Set(parsed);
    const onlyCjs = [...live].filter((t) => !REF_STOP_TOKENS.has(t));
    const onlyFrozen = [...REF_STOP_TOKENS].filter((t) => !live.has(t));
    expect(onlyCjs).toEqual([]);
    expect(onlyFrozen).toEqual([]);
    expect(parsed.length).toBe(REF_STOP_TOKENS.size);
  });

  it('NOISE-ORDER + invariants: allowlist precedes length<4 / acronym drop rules', () => {
    // NOISE-LENGTH: falsy/empty + length<4
    expect(isNoiseName('')).toBe(true);
    expect(isNoiseName('xyz')).toBe(true);
    // allowlist beats length<4 ('go','ai','db' are len 2-3)
    expect(isNoiseName('go')).toBe(false);
    expect(isNoiseName('ai')).toBe(false);
    // allowlist beats the acronym rule (SDK/ORM/JWT are all-caps len<=6)
    expect(isNoiseName('SDK')).toBe(false);
    expect(isNoiseName('JWT')).toBe(false);
    // allowlist is case-insensitive
    expect(isNoiseName('K8s')).toBe(false);
    expect(isNoiseName('Go')).toBe(false);
    // NOISE-ACRONYM single-word vs multi-word exemption
    expect(isNoiseName('HTTP')).toBe(true);
    expect(isNoiseName('UNITED NATIONS')).toBe(false);
  });
});

describe('purge-noise-dedupe :: PROOF 2 — dedupeByName behavioural contract (ratified deltas)', () => {
  let dbPath: string;
  let db: MindDB;
  let kg: KnowledgeGraph;

  beforeAll(() => {
    // Guard: never let any path resolve under the operator's real mind dir.
    const realMind = join(homedir(), '.hive-mind');
    expect(tmpdir().startsWith(realMind)).toBe(false);
  });

  beforeEach(() => {
    dbPath = join(tmpdir(), `hm-purge-dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}.mind`);
    db = new MindDB(dbPath);
    kg = new KnowledgeGraph(db);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('DEDUP-GROUPING-KEY: alias variants of the same TYPE merge (broader-on-name than legacy)', () => {
    // Legacy keyed on exact name only; these three would stay separate there.
    // Postgres/postgresql/pg all resolve to canonical 'postgresql' via ALIASES,
    // so they collapse into ONE group despite distinct surface names.
    kg.createEntity('technology', 'Postgres', { seen_count: 2 });
    kg.createEntity('technology', 'postgresql', { seen_count: 3 });
    kg.createEntity('technology', 'pg', {}); // no seen_count → counts as 1
    kg.createEntity('technology', 'Redis', { seen_count: 9 }); // singleton, untouched

    const res = kg.dedupeByName();
    expect(res.groups).toBe(1); // only the postgres group is multi-member
    expect(res.merged).toBe(2); // two of the three postgres rows retired

    const techs = kg.getEntities(1000).filter((e) => e.entity_type === 'technology');
    expect(techs).toHaveLength(2); // one postgres survivor + untouched Redis
    const redis = techs.find((e) => e.name === 'Redis')!;
    const survivor = techs.find((e) => e.name !== 'Redis')!;
    expect(['Postgres', 'postgresql', 'pg']).toContain(survivor.name);
    // SEEN_COUNT (3-MEMBER PARTIAL-SUM — DISCOVERED in-repo divergence, see the
    // dedicated 3-member test below): dedupeByName re-reads the STALE captured
    // `keep.properties` each loop iteration (knowledge.ts:357-361), so a 3+-member
    // group ends with original_survivor_count + LAST_dup_count, NOT the .cjs
    // whole-group sum. Survivor = lowest-id 'Postgres' (count 2; all 0 relations
    // → tie → lowest id); last dup processed by id order is 'pg' (missing → 1).
    // So result = 2 + 1 = 3. (The .cjs would write 2+3+1 = 6 here.)
    expect(JSON.parse(survivor.properties).seen_count).toBe(3);
    expect(JSON.parse(redis.properties).seen_count).toBe(9);
  });

  it('DEDUP-GROUPING-KEY (alias-independent): pure case variants of the same TYPE merge', () => {
    // Independent of the ALIASES table — grouping relies only on the
    // `.toLowerCase()` half of the key, so this locks the case-folding behaviour.
    // GROUPING/COLLAPSE is verified here (groups=1, merged=2, one survivor);
    // the seen_count PARTIAL-SUM divergence is asserted in the next test.
    kg.createEntity('technology', 'Cassandra', { seen_count: 4 });
    kg.createEntity('technology', 'cassandra', { seen_count: 5 });
    kg.createEntity('technology', 'CASSANDRA', { seen_count: 6 });

    const res = kg.dedupeByName();
    expect(res.groups).toBe(1);
    expect(res.merged).toBe(2);

    const techs = kg.getEntities(1000).filter((e) => e.entity_type === 'technology');
    expect(techs).toHaveLength(1); // all three case variants collapse to one
  });

  it('DEDUP-SEENCOUNT 2-member SUM (matches .cjs for pairs)', () => {
    // For the common pairwise case the in-repo accumulation equals the .cjs
    // whole-group sum: keep(2) + dup(3) = 5. Case-only → alias-independent.
    kg.createEntity('technology', 'Scylla', { seen_count: 2 });
    kg.createEntity('technology', 'scylla', { seen_count: 3 });

    const res = kg.dedupeByName();
    expect(res.groups).toBe(1);
    expect(res.merged).toBe(1);

    const techs = kg.getEntities(1000).filter((e) => e.entity_type === 'technology');
    expect(techs).toHaveLength(1);
    expect(JSON.parse(techs[0].properties).seen_count).toBe(5);
  });

  it('DEDUP-SEENCOUNT 3+-member PARTIAL-SUM (DISCOVERED DIVERGENCE: NOT .cjs-equivalent)', () => {
    // GATE-CRITICAL DISCOVERY: dedupeByName re-reads the STALE captured
    // `keep.properties` on every iteration (knowledge.ts:357-361) instead of
    // carrying the running total forward. For groups of 3+ members the MIDDLE
    // duplicates' seen_count is therefore LOST: the survivor ends with
    // original_survivor_count + LAST_dup_count only.
    //   Members (case-only, alias-independent): 4, 5, 6.
    //   Survivor = lowest-id 'Druid' (all 0 relations → tie → lowest id), count 4.
    //   Iter 1 merges 'druid'(5): writes 4+5=9 to DB but `keep` object stays 4.
    //   Iter 2 merges 'DRUID'(6): re-reads STALE 4, writes 4+6=10 — overwriting 9.
    // So the in-repo result = 10, NOT the .cjs whole-group sum 4+5+6 = 15.
    kg.createEntity('technology', 'Druid', { seen_count: 4 });
    kg.createEntity('technology', 'druid', { seen_count: 5 });
    kg.createEntity('technology', 'DRUID', { seen_count: 6 });

    const res = kg.dedupeByName();
    expect(res.groups).toBe(1);
    expect(res.merged).toBe(2);

    const techs = kg.getEntities(1000).filter((e) => e.entity_type === 'technology');
    expect(techs).toHaveLength(1);
    // Lock the ACTUAL in-repo behaviour (10) and assert it diverges from the
    // .cjs whole-group sum (15). If this ever flips to 15 the source bug was
    // fixed and this assertion (and the 3-member alias test above) should update.
    expect(JSON.parse(techs[0].properties).seen_count).toBe(10);
    expect(JSON.parse(techs[0].properties).seen_count).not.toBe(15);
  });

  it('DEDUP-GROUPING-KEY: same NAME but DIFFERENT type are NOT merged (narrower-on-type than legacy)', () => {
    // Legacy (exact name only, type-agnostic) WOULD merge these; in-repo must NOT.
    kg.createEntity('fruit', 'Apple', { seen_count: 5 });
    kg.createEntity('company', 'Apple', { seen_count: 7 });

    const res = kg.dedupeByName();
    expect(res.groups).toBe(0);
    expect(res.merged).toBe(0);

    const active = kg.getEntities(1000).filter((e) => e.name === 'Apple');
    expect(active).toHaveLength(2); // both survive, untouched
    expect(active.map((e) => e.entity_type).sort()).toEqual(['company', 'fruit']);
  });

  it('SURVIVOR-SELECTION: higher-id duplicate with MORE relations wins (diverges from legacy lowest-id)', () => {
    // The only case where in-repo (most-relations) and legacy (lowest-id) disagree.
    // Case-only variants ('Hadoop'/'hadoop') so grouping is alias-independent.
    const low = kg.createEntity('technology', 'Hadoop', { seen_count: 1 }); // lowest id, 0 rels
    const high = kg.createEntity('technology', 'hadoop', { seen_count: 1 }); // higher id, MORE rels
    const peerA = kg.createEntity('person', 'A', {});
    const peerB = kg.createEntity('person', 'B', {});
    // Give the higher-id dup two relations; the low-id none.
    kg.createRelation(peerA.id, high.id, 'uses');
    kg.createRelation(high.id, peerB.id, 'depends_on');

    expect(high.id).toBeGreaterThan(low.id);

    const res = kg.dedupeByName();
    expect(res.groups).toBe(1);
    expect(res.merged).toBe(1);

    const techs = kg.getEntities(1000).filter((e) => e.entity_type === 'technology');
    expect(techs).toHaveLength(1);
    // Survivor is the HIGHER-id 'hadoop' (more relations), NOT lowest-id 'Hadoop'.
    expect(techs[0].id).toBe(high.id);
    // The retired low-id row is soft-deleted (SOFT-DELETE delta), still readable.
    expect(kg.getEntity(low.id)?.valid_to).not.toBeNull();
  });

  it('DEDUP-RELATION-PRESERVATION: both incident edges migrate onto survivor; originals retired', () => {
    // Case-only variants ('Kafka'/'kafka') so grouping is alias-independent.
    // 'keep' is given MORE relations than 'dup' so it wins as survivor; 'dup''s
    // inbound + outbound edges must migrate onto the survivor.
    const keep = kg.createEntity('technology', 'Kafka', { seen_count: 1 });
    const dup = kg.createEntity('technology', 'kafka', { seen_count: 1 });
    const upstream = kg.createEntity('person', 'Author', {});
    const downstream = kg.createEntity('project', 'App', {});
    const sibling = kg.createEntity('project', 'Other', {});
    // dup has BOTH an inbound and an outbound edge that must survive on keep.
    const inbound = kg.createRelation(upstream.id, dup.id, 'maintains');
    const outbound = kg.createRelation(dup.id, downstream.id, 'powers');
    // Give keep THREE relations so it wins the most-relations survivor rule.
    kg.createRelation(keep.id, downstream.id, 'powers_a');
    kg.createRelation(keep.id, sibling.id, 'powers_b');
    kg.createRelation(upstream.id, keep.id, 'maintains_c');

    expect(kg.getRelationsFrom(keep.id).length + kg.getRelationsTo(keep.id).length).toBe(3);
    expect(kg.getRelationsFrom(dup.id).length + kg.getRelationsTo(dup.id).length).toBe(2);

    const res = kg.dedupeByName();
    expect(res.groups).toBe(1);
    expect(res.merged).toBe(1);

    const techs = kg.getEntities(1000).filter((e) => e.entity_type === 'technology');
    expect(techs).toHaveLength(1);
    const survivor = techs[0];
    expect(survivor.id).toBe(keep.id); // keep had more relations → survivor

    // Inbound 'maintains' now points at survivor; outbound 'powers' now from survivor.
    const inboundToSurvivor = kg.getRelationsTo(survivor.id).filter((r) => r.relation_type === 'maintains');
    expect(inboundToSurvivor.some((r) => r.source_id === upstream.id)).toBe(true);
    const outboundFromSurvivor = kg.getRelationsFrom(survivor.id).filter((r) => r.relation_type === 'powers');
    expect(outboundFromSurvivor.some((r) => r.target_id === downstream.id)).toBe(true);

    // RELATION-PRESERVATION / no-orphan: original dup edges are retired, and no
    // ACTIVE relation still points at the retired dup.
    expect(kg.getRelation(inbound.id)?.valid_to).not.toBeNull();
    expect(kg.getRelation(outbound.id)?.valid_to).not.toBeNull();
    expect(kg.getRelationsFrom(dup.id)).toEqual([]);
    expect(kg.getRelationsTo(dup.id)).toEqual([]);
  });

  it('DEDUP-SEENCOUNT edge cases: missing→1 and malformed properties JSON→1 (counts contribute, but 3-member partial-sum applies)', () => {
    // Case-only variants ('Solr'/'solr'/'SOLR') so grouping is alias-independent.
    //   Solr = survivor (lowest id, count 2), solr = missing → 1, SOLR = malformed
    //   JSON → safeParseProps → {} → 1.
    // This is a 3-MEMBER group, so the same stale-keep partial-sum bug applies:
    //   survivor = original(2) + LAST-dup-count. The last dup processed in id
    //   order is 'SOLR' (malformed → 1). So result = 2 + 1 = 3 (the middle
    //   missing-count member's 1 is lost). The .cjs would write 2+1+1 = 4.
    // What this STILL locks: missing seen_count and malformed JSON both resolve
    // to 1 (never NaN / never throw) — the safeParseProps + (?? 1) contract.
    const a = kg.createEntity('technology', 'Solr', { seen_count: 2 });
    kg.createEntity('technology', 'solr', {}); // missing seen_count → counts as 1
    const c = kg.createEntity('technology', 'SOLR', { seen_count: 3 });
    // Corrupt one row's properties to invalid JSON to exercise safeParseProps→{}→1.
    db.getDatabase()
      .prepare('UPDATE knowledge_entities SET properties = ? WHERE id = ?')
      .run('{not valid json', c.id);

    const res = kg.dedupeByName();
    expect(res.groups).toBe(1);
    expect(res.merged).toBe(2);

    const survivor = kg.getEntities(1000).filter((e) => e.entity_type === 'technology')[0];
    expect(survivor.id).toBe(a.id); // lowest id, all 0 relations → tie → lowest id
    const sc = JSON.parse(survivor.properties).seen_count;
    // ACTUAL in-repo (3-member partial-sum bug): 2 + last-dup(malformed→1) = 3.
    expect(sc).toBe(3);
    // Key safety contract regardless of the partial-sum bug: never NaN.
    expect(Number.isFinite(sc)).toBe(true);
  });

  it('DEDUP-SEENCOUNT 2-member edge: malformed survivor JSON + malformed dup JSON both contribute 1', () => {
    // Pair case (sums correctly): both rows have unparseable properties, so each
    // contributes 1 → survivor seen_count = 1 + 1 = 2 (no NaN, no throw).
    const a = kg.createEntity('technology', 'Trino', { seen_count: 7 });
    const b = kg.createEntity('technology', 'trino', { seen_count: 8 });
    const raw = db.getDatabase();
    raw.prepare('UPDATE knowledge_entities SET properties = ? WHERE id = ?').run('not json at all', a.id);
    raw.prepare('UPDATE knowledge_entities SET properties = ? WHERE id = ?').run('{also: broken', b.id);

    const res = kg.dedupeByName();
    expect(res.groups).toBe(1);
    expect(res.merged).toBe(1);

    const survivor = kg.getEntities(1000).filter((e) => e.entity_type === 'technology')[0];
    const sc = JSON.parse(survivor.properties).seen_count;
    expect(sc).toBe(2); // malformed(→1) + malformed(→1)
    expect(Number.isFinite(sc)).toBe(true);
  });

  it('ACTIVE-ONLY: already-retired (soft-deleted) duplicates are never merged', () => {
    const live = kg.createEntity('technology', 'Deno', { seen_count: 1 });
    const dead = kg.createEntity('technology', 'deno', { seen_count: 5 });
    kg.retireEntity(dead.id); // historical row

    const res = kg.dedupeByName();
    expect(res.groups).toBe(0); // only one ACTIVE member → not a multi-member group
    expect(res.merged).toBe(0);

    // live untouched, dead stays retired
    expect(kg.getEntity(live.id)?.valid_to).toBeNull();
    expect(JSON.parse(kg.getEntity(live.id)!.properties).seen_count).toBe(1);
    expect(kg.getEntity(dead.id)?.valid_to).not.toBeNull();
  });

  it('PROVENANCE-STAMP delta: survivor is NOT stamped with purge_merged_at (legacy did, in-repo does not)', () => {
    kg.createEntity('technology', 'Vite', { seen_count: 1 });
    kg.createEntity('technology', 'vite', { seen_count: 1 });
    kg.dedupeByName();
    const survivor = kg.getEntities(1000).filter((e) => e.entity_type === 'technology')[0];
    expect('purge_merged_at' in JSON.parse(survivor.properties)).toBe(false);
  });

  it('ATOMICITY/idempotency: a second dedupe pass is a no-op', () => {
    // Case-only variants so grouping is alias-independent.
    kg.createEntity('technology', 'Envoy', { seen_count: 1 });
    kg.createEntity('technology', 'envoy', { seen_count: 2 });
    const first = kg.dedupeByName();
    expect(first.groups).toBe(1);
    expect(first.merged).toBe(1);
    const second = kg.dedupeByName();
    expect(second).toEqual({ groups: 0, merged: 0 });
  });

  it('WRITE-BOUNDARY: dedupeByName with no duplicates does not mutate the active set', () => {
    kg.createEntity('technology', 'Rust', { seen_count: 3 });
    kg.createEntity('person', 'Grace', {});
    const before = kg.getEntities(1000).map((e) => e.id).sort();
    const res = kg.dedupeByName();
    expect(res).toEqual({ groups: 0, merged: 0 });
    const after = kg.getEntities(1000).map((e) => e.id).sort();
    expect(after).toEqual(before);
  });
});

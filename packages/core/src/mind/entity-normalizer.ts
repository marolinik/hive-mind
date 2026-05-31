/**
 * Entity-name normalization + duplicate grouping.
 *
 * The `ALIASES` table resolves common short forms to their canonical names
 * (e.g. `postgres`, `pg` → `postgresql`). This is a small, hand-curated seed
 * list — downstream consumers who need domain-specific aliases can extend by
 * wrapping `normalizeEntityName` or maintaining their own map.
 *
 * Extracted from Waggle OS `packages/core/src/mind/entity-normalizer.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

const ALIASES: string[][] = [
  ['postgresql', 'postgres', 'pg'],
  ['javascript', 'js'],
  ['typescript', 'ts'],
  ['kubernetes', 'k8s'],
  ['new york city', 'nyc'],
  ['nodejs', 'node.js', 'node'],
  ['react.js', 'reactjs', 'react'],
  ['vue.js', 'vuejs', 'vue'],
  ['python', 'py'],
  ['mongodb', 'mongo'],
];

const aliasMap = new Map<string, string>();
for (const group of ALIASES) {
  const canonical = group[0];
  for (const alias of group) {
    aliasMap.set(alias, canonical);
  }
}

export function normalizeEntityName(name: string): string {
  const lower = name.toLowerCase();
  return aliasMap.get(lower) ?? lower;
}

export interface EntityRef {
  id: string;
  name: string;
  type: string;
}

export function findDuplicates(entities: EntityRef[]): EntityRef[][] {
  const groups = new Map<string, EntityRef[]>();
  for (const entity of entities) {
    const key = `${normalizeEntityName(entity.name)}::${entity.type.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(entity);
  }
  return Array.from(groups.values());
}

// ── Write-time noise filter ───────────────────────────────────────────────
// Canonical, shared definition (was duplicated in cli/cognify.ts and the
// .harvest/purge-noise-entities.cjs glue). Applied at extraction time so
// low-signal names never enter the knowledge graph instead of being purged
// after the fact. STOP_TOKENS + isLikelyAcronym are byte-identical to the
// .harvest reference so the equivalence gate is clean; TECH_ALLOWLIST is the
// one documented, reviewed divergence (see .planning/PHASE-1-PLAN.md 1.6).

/** Capitalized sentence-starts / verbs / weekday + month tokens that are
 *  formatting artefacts, not entities. Title-cased to match extractor output. */
const STOP_TOKENS = new Set<string>([
  // sentence-starts and pronouns
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'Why', 'How',
  'What', 'Who', 'Which', 'If', 'And', 'But', 'Or', 'So', 'For', 'Nor',
  'Yet', 'As', 'At', 'By', 'On', 'In', 'To', 'From', 'With', 'Without',
  'Into', 'Onto', 'Upon', 'Over', 'Under', 'Between', 'Among',
  // verbs commonly capitalized at sentence start / in API names / log prefixes
  'Add', 'Remove', 'Set', 'Get', 'Update', 'Delete', 'Create', 'List',
  'Search', 'Find', 'Run', 'Build', 'Use', 'Make', 'Test', 'Check',
  'Read', 'Write', 'Edit', 'Save', 'Load', 'Open', 'Close', 'Start',
  'Stop', 'Show', 'Hide', 'Push', 'Pull', 'Fix', 'Done', 'Skip',
  'Wait', 'Try', 'Note', 'Warn', 'Info', 'Debug', 'Trace',
  'Todo', 'Fixme', 'Should', 'Could', 'Would', 'Must', 'Will', 'Shall',
  'Can', 'May', 'Might',
  // days
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  // months
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
  'Nov', 'Dec',
  'January', 'February', 'March', 'April', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]);

/** Real short tech names the generic heuristics would wrongly drop (too short,
 *  or all-caps acronyms). Lowercased; checked case-insensitively. This is the
 *  one intentional divergence from purge-noise-entities.cjs. */
const TECH_ALLOWLIST = new Set<string>([
  // languages / runtimes
  'go', 'php', 'bun', 'deno',
  // package managers / editors / tools
  'npm', 'pip', 'gem', 'vim', 'git',
  // frameworks / libraries
  'vue', 'zod', 'nuxt', 'vite', 'hono',
  // domains / concepts that are genuine entities
  'ai', 'ml', 'db', 'os', 'ui', 'ux', 'io', 'ci', 'cd', 'k8s',
  'sdk', 'orm', 'jwt', 'ssh', 'dns', 'gpu', 'cpu',
]);

/** All-caps tokens up to 6 chars (API, CLI, JSON, HTTP, SQL, AWS, URL, UUID) —
 *  almost always formatting artefacts, not subjects. */
export function isLikelyAcronym(s: string): boolean {
  return /^[A-Z]+$/.test(s) && s.length <= 6;
}

/**
 * True when `name` is too low-signal to enter the knowledge graph: empty,
 * shorter than 4 chars, a stop token, or a single-word all-caps acronym —
 * UNLESS it is on the tech allowlist (npm, Go, AI, …). Multi-word names skip
 * the acronym filter (real entities like "Acme Corp").
 */
export function isNoiseName(name: string): boolean {
  if (!name) return true;
  if (TECH_ALLOWLIST.has(name.toLowerCase())) return false;
  if (name.length < 4) return true;
  if (STOP_TOKENS.has(name)) return true;
  if (!/\s/.test(name) && isLikelyAcronym(name)) return true;
  return false;
}

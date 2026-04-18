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

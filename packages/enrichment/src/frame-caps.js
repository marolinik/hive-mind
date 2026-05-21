/**
 * Tier presets for cap budgets per surface.
 */
export const TIER_PRESETS = Object.freeze({
  small: Object.freeze({ frames: 3, identity: 1, awareness: 2 }),
  mid: Object.freeze({ frames: 6, identity: 3, awareness: 4 }),
  frontier: Object.freeze({ frames: 10, identity: 5, awareness: 8 }),
});

const DEFAULT_TIER = 'mid';

export function getTier(name) {
  const envTier = process.env.HIVE_MIND_TIER;
  const requested = (name || envTier || DEFAULT_TIER).toLowerCase();
  return TIER_PRESETS[requested] || TIER_PRESETS[DEFAULT_TIER];
}

export function getTierName() {
  const envTier = process.env.HIVE_MIND_TIER;
  const requested = (envTier || DEFAULT_TIER).toLowerCase();
  return TIER_PRESETS[requested] ? requested : DEFAULT_TIER;
}

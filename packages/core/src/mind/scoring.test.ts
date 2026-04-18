import { describe, it, expect } from 'vitest';
import {
  SCORING_PROFILES,
  computeTemporalScore,
  computePopularityScore,
  computeContextualScore,
  computeImportanceScore,
  computeRelevance,
} from './scoring.js';

describe('scoring', () => {
  describe('computeTemporalScore', () => {
    it('returns 1.0 for timestamps within the 7-day recency window', () => {
      const now = new Date();
      expect(computeTemporalScore(now.toISOString())).toBe(1.0);

      const fiveDaysAgo = new Date(now.getTime() - 5 * 86400_000);
      expect(computeTemporalScore(fiveDaysAgo.toISOString())).toBe(1.0);
    });

    it('decays exponentially past the recency window (half-life = 30 days)', () => {
      const now = Date.now();
      // 30 days ago → 0.5^(30/30) = 0.5. Run at half-life exactly so the assertion
      // pins the decay function's algebra rather than its composition with the boost.
      const thirtyDaysAgo = new Date(now - 30 * 86400_000);
      const score = computeTemporalScore(thirtyDaysAgo.toISOString());
      expect(score).toBeGreaterThan(0.48);
      expect(score).toBeLessThan(0.52);
    });

    it('approaches zero for very old timestamps', () => {
      const twoYearsAgo = new Date(Date.now() - 2 * 365 * 86400_000);
      expect(computeTemporalScore(twoYearsAgo.toISOString())).toBeLessThan(0.01);
    });
  });

  describe('computePopularityScore', () => {
    it('returns 1.0 for zero accesses (log10(1) = 0)', () => {
      expect(computePopularityScore(0)).toBe(1.0);
    });

    it('grows sub-linearly with access count', () => {
      const nine = computePopularityScore(9);
      const ninetyNine = computePopularityScore(99);
      // log10(10) = 1, log10(100) = 2 → scores differ by exactly 0.1.
      expect(nine).toBeCloseTo(1.1, 5);
      expect(ninetyNine).toBeCloseTo(1.2, 5);
    });
  });

  describe('computeContextualScore', () => {
    it('returns 0 when no graph context is provided', () => {
      expect(computeContextualScore(42, undefined)).toBe(0);
    });

    it('returns 0 for frames missing from the distance map', () => {
      const distances = new Map<number, number>([[1, 0]]);
      expect(computeContextualScore(42, distances)).toBe(0);
    });

    it('decreases with graph distance in the documented steps', () => {
      const distances = new Map<number, number>([
        [1, 0],
        [2, 1],
        [3, 2],
        [4, 3],
        [5, 4],
      ]);
      expect(computeContextualScore(1, distances)).toBe(1.0);
      expect(computeContextualScore(2, distances)).toBe(0.7);
      expect(computeContextualScore(3, distances)).toBe(0.4);
      expect(computeContextualScore(4, distances)).toBe(0.2);
      expect(computeContextualScore(5, distances)).toBe(0);
    });
  });

  describe('computeImportanceScore', () => {
    it('maps each importance tier to the documented multiplier', () => {
      expect(computeImportanceScore('critical')).toBe(2.0);
      expect(computeImportanceScore('important')).toBe(1.5);
      expect(computeImportanceScore('normal')).toBe(1.0);
      expect(computeImportanceScore('temporary')).toBe(0.7);
      expect(computeImportanceScore('deprecated')).toBe(0.3);
    });
  });

  describe('computeRelevance', () => {
    it('combines the four feature scores by their weights', () => {
      const now = new Date().toISOString();
      const weights = SCORING_PROFILES.balanced;
      // Fresh frame + 0 accesses + no graph context + normal importance.
      const score = computeRelevance(
        { id: 1, last_accessed: now, access_count: 0, importance: 'normal' },
        weights,
      );
      // temporal=1.0*0.4 + popularity=1.0*0.2 + contextual=0*0.2 + importance=1.0*0.2 = 0.8
      expect(score).toBeCloseTo(0.8, 5);
    });

    it('rewards higher importance under the `important` profile', () => {
      const now = new Date().toISOString();
      const balanced = computeRelevance(
        { id: 1, last_accessed: now, access_count: 0, importance: 'critical' },
        SCORING_PROFILES.balanced,
      );
      const important = computeRelevance(
        { id: 1, last_accessed: now, access_count: 0, importance: 'critical' },
        SCORING_PROFILES.important,
      );
      expect(important).toBeGreaterThan(balanced);
    });

    it('boosts graph-adjacent frames under the `connected` profile', () => {
      // All profile weights sum to 1.0, so when every feature contributes the
      // same value the profiles are indistinguishable. The connected profile
      // only shines when the contextual and temporal features diverge — so we
      // use an *old* frame that's graph-adjacent to surface that difference.
      const oneYearAgo = new Date(Date.now() - 365 * 86400_000).toISOString();
      const distances = new Map<number, number>([[1, 0]]);
      const balanced = computeRelevance(
        { id: 1, last_accessed: oneYearAgo, access_count: 0, importance: 'normal' },
        SCORING_PROFILES.balanced,
        { graphDistances: distances },
      );
      const connected = computeRelevance(
        { id: 1, last_accessed: oneYearAgo, access_count: 0, importance: 'normal' },
        SCORING_PROFILES.connected,
        { graphDistances: distances },
      );
      expect(connected).toBeGreaterThan(balanced);
    });
  });
});

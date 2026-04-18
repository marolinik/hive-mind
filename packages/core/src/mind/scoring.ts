/**
 * Scoring — relevance weighting for hybrid search results.
 *
 * Sits on top of the RRF-fused keyword+vector ranking in HybridSearch. The
 * ranker produces a relevance-by-match score; this module produces a per-frame
 * personalization multiplier based on four features: temporal recency,
 * popularity, graph context, and importance. The final score is the product
 * of the two, so profile changes tune personalization without perturbing IR
 * quality.
 *
 * Extracted from Waggle OS `packages/core/src/mind/scoring.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import type { Importance } from './frames.js';

export type ScoringProfile = 'balanced' | 'recent' | 'important' | 'connected';

export interface ScoringWeights {
  temporal: number;
  popularity: number;
  contextual: number;
  importance: number;
}

export const SCORING_PROFILES: Record<ScoringProfile, ScoringWeights> = {
  balanced: { temporal: 0.4, popularity: 0.2, contextual: 0.2, importance: 0.2 },
  recent: { temporal: 0.6, popularity: 0.1, contextual: 0.2, importance: 0.1 },
  important: { temporal: 0.1, popularity: 0.1, contextual: 0.2, importance: 0.6 },
  connected: { temporal: 0.1, popularity: 0.1, contextual: 0.6, importance: 0.2 },
};

const IMPORTANCE_WEIGHTS: Record<Importance, number> = {
  critical: 2.0,
  important: 1.5,
  normal: 1.0,
  temporary: 0.7,
  deprecated: 0.3,
};

const HALF_LIFE_DAYS = 30;
const RECENCY_BOOST_DAYS = 7;

export interface ScoredResult {
  frameId: number;
  rrfScore: number;
  relevanceScore: number;
  finalScore: number;
}

export interface ScoringContext {
  recentEntityIds?: number[];
  graphDistances?: Map<number, number>; // frameId -> shortest BFS distance
}

export function computeTemporalScore(lastAccessedIso: string): number {
  const now = Date.now();
  const accessed = new Date(lastAccessedIso).getTime();
  const daysSince = (now - accessed) / (1000 * 60 * 60 * 24);

  if (daysSince <= RECENCY_BOOST_DAYS) {
    return 1.0;
  }

  // Exponential decay with 30-day half-life.
  return Math.pow(0.5, daysSince / HALF_LIFE_DAYS);
}

export function computePopularityScore(accessCount: number): number {
  return 1 + Math.log10(1 + accessCount) * 0.1;
}

export function computeContextualScore(
  frameId: number,
  graphDistances: Map<number, number> | undefined,
): number {
  if (!graphDistances || !graphDistances.has(frameId)) return 0;
  const distance = graphDistances.get(frameId)!;
  if (distance === 0) return 1.0;
  if (distance === 1) return 0.7;
  if (distance === 2) return 0.4;
  if (distance === 3) return 0.2;
  return 0;
}

export function computeImportanceScore(importance: Importance): number {
  return IMPORTANCE_WEIGHTS[importance];
}

export function computeRelevance(
  frame: {
    id: number;
    last_accessed: string;
    access_count: number;
    importance: Importance;
  },
  weights: ScoringWeights,
  context: ScoringContext = {},
): number {
  const temporal = computeTemporalScore(frame.last_accessed);
  const popularity = computePopularityScore(frame.access_count);
  const contextual = computeContextualScore(frame.id, context.graphDistances);
  const importance = computeImportanceScore(frame.importance);

  return (
    temporal * weights.temporal +
    popularity * weights.popularity +
    contextual * weights.contextual +
    importance * weights.importance
  );
}

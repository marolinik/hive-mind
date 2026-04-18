/**
 * `hive-mind-cli cognify` — extract entities and relations from recent
 * frames into the knowledge graph. High-quality extraction requires an
 * LLM, so this command is a deliberately small heuristic pass suitable
 * for a nightly cron: it walks new frames, pulls capitalized noun
 * phrases, normalizes them, and creates/updates KG entities. Callers
 * who want richer extraction should run the MCP `save_entity` tool
 * with an LLM-driven agent instead.
 */

import { openPersonalMind, type CliEnv } from '../setup.js';
import { normalizeEntityName } from '@hive-mind/core';

export interface CognifyOptions {
  /** Process frames with id > since. Defaults to last cognify watermark or 0. */
  since?: number;
  limit?: number;
  env?: CliEnv;
}

export interface CognifyResult {
  framesScanned: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  lastFrameId: number;
}

// Heuristic: consecutive capitalised words with optional connectors.
// Deliberately conservative — we prefer to miss entities than to create noise.
const ENTITY_PATTERN = /\b([A-Z][a-zA-Z]+(?:\s+(?:de|of|&)\s+|\s+)[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/g;
const SIMPLE_ENTITY_PATTERN = /\b([A-Z][a-zA-Z]{2,})\b/g;

// Skip common sentence-starts and pronouns that the naive regex catches.
const STOP_TOKENS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'Why', 'How',
  'What', 'Who', 'Which', 'If', 'And', 'But', 'Or', 'So', 'For', 'Nor',
  'Yet', 'As', 'At', 'By', 'On', 'In', 'To', 'From', 'With', 'Without',
  'Into', 'Onto', 'Upon', 'Over', 'Under', 'Between', 'Among',
]);

function extractCandidateEntities(text: string): string[] {
  const seen = new Set<string>();

  // Multi-word candidates first (more specific — Project Alpha, Acme Corp).
  for (const match of text.matchAll(ENTITY_PATTERN)) {
    const candidate = match[1].trim();
    if (candidate.length >= 4) seen.add(candidate);
  }

  // Single-word candidates — filter stop words.
  for (const match of text.matchAll(SIMPLE_ENTITY_PATTERN)) {
    const candidate = match[1].trim();
    if (STOP_TOKENS.has(candidate)) continue;
    if (candidate.length < 3) continue;
    seen.add(candidate);
  }

  return [...seen];
}

export async function runCognify(options: CognifyOptions = {}): Promise<CognifyResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;

  try {
    const since = options.since ?? 0;
    const limit = options.limit ?? 500;

    const raw = env.db.getDatabase();
    const frames = raw.prepare(
      'SELECT id, content FROM memory_frames WHERE id > ? ORDER BY id ASC LIMIT ?',
    ).all(since, limit) as { id: number; content: string }[];

    let entitiesCreated = 0;
    let entitiesUpdated = 0;
    let lastFrameId = since;

    for (const frame of frames) {
      lastFrameId = Math.max(lastFrameId, frame.id);
      const candidates = extractCandidateEntities(frame.content);

      for (const name of candidates) {
        const normalized = normalizeEntityName(name);
        if (normalized.length < 3) continue;

        // Dedup by exact normalized match — we conservatively classify everything
        // as 'concept' because the heuristic can't tell person from org reliably.
        const existing = env.kg
          .searchEntities(name, 3)
          .find((e) => normalizeEntityName(e.name) === normalized);

        if (existing) {
          // Touch properties to bump "seen in frame" count for future ranking.
          const existingProps = safeParse(existing.properties);
          const seenCount = Number(existingProps.seen_count ?? 1) + 1;
          env.kg.updateEntity(existing.id, {
            properties: { ...existingProps, seen_count: seenCount },
          });
          entitiesUpdated++;
        } else {
          try {
            env.kg.createEntity('concept', name, { seen_count: 1, source: 'cognify' });
            entitiesCreated++;
          } catch { /* validation may reject — skip */ }
        }
      }
    }

    return {
      framesScanned: frames.length,
      entitiesCreated,
      entitiesUpdated,
      lastFrameId,
    };
  } finally {
    close();
  }
}

function safeParse(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

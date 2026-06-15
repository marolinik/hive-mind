// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MindDB } from './db.js';
import { FrameStore } from './frames.js';
import { SessionStore } from './sessions.js';
import { rawTurnHeader } from '../harvest/raw-turns.js';
import { fetchRawDetailLane, rawTurnBody } from './raw-detail-lane.js';
import type { Reranker } from './inprocess-reranker.js';

/**
 * RAWDETAIL recall lane: pool (window/FTS) → CE top-K → ±1 dialogue
 * neighbors → chronological order, excluding already-rendered frames.
 */

/** Deterministic fake CE: score = number of marker words present in the doc. */
function markerReranker(markers: string[]): Reranker {
  return {
    scoreBatch: async (_q: string, docs: string[]) =>
      docs.map(d => markers.reduce((s, m) => s + (d.includes(m) ? 1 : 0), 0)),
  } as Reranker;
}

describe('fetchRawDetailLane', () => {
  let db: MindDB;
  let frames: FrameStore;
  let gopId: string;

  beforeEach(() => {
    db = new MindDB(':memory:');
    frames = new FrameStore(db);
    gopId = new SessionStore(db).create().gop_id;
  });

  afterEach(() => db.close());

  /** Seed one conversation of consecutive turns, one day apart. */
  function seedConv(conv: string, texts: string[], baseDay = 10): number[] {
    const ids: number[] = [];
    texts.forEach((text, i) => {
      const day = String(baseDay + i).padStart(2, '0');
      const f = frames.createIFrame(
        gopId,
        `${rawTurnHeader(conv, i, i % 2 === 0 ? 'user' : 'assistant')}\n${text}`,
        'normal',
        'import',
        `2026-05-${day}T12:00:00Z`,
      );
      ids.push(f.id);
    });
    return ids;
  }

  it('returns CE-top turns expanded with ±1 dialogue neighbors, chronological', async () => {
    seedConv('conv-a', [
      'we talked about logistics planning',
      'I saw a painting of a sunset with a pink sky',   // CE hit (turn 1)
      'it was at the Mauritshuis museum',
      'unrelated chatter about lunch options',
    ]);
    const hits = await fetchRawDetailLane(
      db.getDatabase(),
      'what painting did they discuss',
      markerReranker(['painting']),
      { k: 1 },
    );
    // turn 1 + neighbors 0 and 2, in dialogue order
    expect(hits.map(h => h.turn)).toEqual([0, 1, 2]);
    expect(hits[1].speaker).toBe('assistant');
    expect(rawTurnBody(hits[1].content)).toContain('pink sky');
  });

  it('respects excludeIds (already-rendered frames never double-render)', async () => {
    const ids = seedConv('conv-b', [
      'first turn about painting brushes',
      'second turn about painting canvases',
      'third turn about painting frames',
    ]);
    const hits = await fetchRawDetailLane(
      db.getDatabase(),
      'painting supplies',
      markerReranker(['painting']),
      { k: 1, excludeIds: new Set([ids[0]]) },
    );
    expect(hits.map(h => h.id)).not.toContain(ids[0]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('date window restricts the pool to in-window turns', async () => {
    seedConv('conv-c', [
      'painting discussion in early may',     // 2026-05-10
      'painting discussion mid may',          // 2026-05-11
      'painting discussion late may',         // 2026-05-12
    ]);
    const hits = await fetchRawDetailLane(
      db.getDatabase(),
      'painting discussion',
      markerReranker(['painting']),
      { k: 3, window: { since: '2026-05-11', until: '2026-05-11' } },
    );
    // pool = only the mid-may turn; neighbor expansion may pull ±1 — but the
    // CE top itself must be the in-window turn
    expect(hits.some(h => h.content.includes('mid may'))).toBe(true);
  });

  it('empty window falls back to FTS so the lane never loses recall', async () => {
    seedConv('conv-d', ['the gallery showed a watercolor landscape']);
    const hits = await fetchRawDetailLane(
      db.getDatabase(),
      'watercolor landscape gallery',
      markerReranker(['watercolor']),
      { window: { since: '2020-01-01', until: '2020-01-31' } },
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns [] when no raw turns exist', async () => {
    frames.createIFrame(gopId, 'plain frame about painting', 'normal', 'system');
    const hits = await fetchRawDetailLane(
      db.getDatabase(),
      'painting',
      markerReranker(['painting']),
    );
    expect(hits).toEqual([]);
  });

  it('soft-fails to [] when the reranker throws', async () => {
    seedConv('conv-e', ['painting one', 'painting two']);
    const broken = { scoreBatch: async () => { throw new Error('model load failed'); } } as unknown as Reranker;
    const hits = await fetchRawDetailLane(db.getDatabase(), 'painting', broken);
    expect(hits).toEqual([]);
  });

  it('neighbor expansion never crosses conversations', async () => {
    seedConv('conv-f', ['solo painting turn in conv f']);
    seedConv('conv-g', ['unrelated turn in conv g'], 20);
    const hits = await fetchRawDetailLane(
      db.getDatabase(),
      'painting',
      markerReranker(['painting']),
      { k: 1 },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].conv).toBe('conv-f');
  });
});

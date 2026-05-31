import { describe, it, expect } from 'vitest';
import { isoYearWeek, trimContent, buildDigestPrompt, type ActivityBucket } from './digest.js';

describe('digest helpers', () => {
  it('isoYearWeek returns Thursday-anchored ISO YYYY-Www', () => {
    expect(isoYearWeek(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01'); // Thu → W01
    expect(isoYearWeek(new Date('2026-01-05T12:00:00Z'))).toBe('2026-W02'); // following Mon
    expect(isoYearWeek(new Date('2025-12-31T12:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('trimContent caps long content with an ellipsis, leaves short content alone', () => {
    expect(trimContent('  short body  ')).toBe('short body');
    const long = 'x'.repeat(600);
    const out = trimContent(long);
    expect(out.length).toBe(501); // 500 + '…'
    expect(out.endsWith('…')).toBe(true);
  });

  it('buildDigestPrompt renders the canonical prompt (equivalence-gated)', () => {
    const buckets: ActivityBucket[] = [
      {
        mind: 'personal',
        frames: [{ id: 1, content: 'shipped the dedupe', importance: 'important', created_at: '2026-05-30 10:00:00' }],
        pages: [{ slug: 'neo4j', name: 'Neo4j', page_type: 'entity', source_count: 30, compiled_at: '2026-05-30 11:00:00' }],
      },
      { mind: 'empty-ws', frames: [], pages: [] }, // skipped (no signal)
    ];
    const prompt = buildDigestPrompt('2026-W22', '2026-05-24 08:00:00', '2026-05-31 08:00:00', buckets);

    expect(prompt.startsWith('You are summarising one developer')).toBe(true);
    expect(prompt).toContain('WEEK: 2026-W22 (frames + wiki pages from 2026-05-24 08:00:00 → 2026-05-31 08:00:00)');
    expect(prompt).toContain('### Mind: personal');
    expect(prompt).toContain('- (important) 2026-05-30 10:00:00: shipped the dedupe');
    expect(prompt).toContain('- entity `neo4j` "Neo4j" (30 sources, compiled 2026-05-30 11:00:00)');
    expect(prompt).not.toContain('### Mind: empty-ws'); // zero-signal minds omitted
    expect(prompt.endsWith('Now emit the digest in the exact format above.')).toBe(true);
  });
});

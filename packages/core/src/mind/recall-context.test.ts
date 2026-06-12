// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
import { describe, it, expect } from 'vitest';
import {
  TEMPORAL_GUIDANCE,
  toDatePrefix,
  renderDatedSnippet,
  referenceDate,
  renderReferenceDateLine,
} from './recall-context.js';

describe('recall-context', () => {
  describe('TEMPORAL_GUIDANCE', () => {
    it('teaches relative-date arithmetic with the worked examples', () => {
      expect(TEMPORAL_GUIDANCE).toContain('[YYYY-MM-DD]');
      expect(TEMPORAL_GUIDANCE).toContain('CALCULATE');
      expect(TEMPORAL_GUIDANCE).toContain('GRANULARITY');
    });
  });

  describe('toDatePrefix', () => {
    it('slices an ISO datetime to its date', () => {
      expect(toDatePrefix('2026-06-09T12:34:56Z')).toBe('2026-06-09');
    });

    it('passes a bare date through', () => {
      expect(toDatePrefix('2026-06-09')).toBe('2026-06-09');
    });

    it('returns null for missing or too-short values', () => {
      expect(toDatePrefix(null)).toBeNull();
      expect(toDatePrefix(undefined)).toBeNull();
      expect(toDatePrefix('')).toBeNull();
      expect(toDatePrefix('2026-06')).toBeNull();
    });
  });

  describe('renderDatedSnippet', () => {
    it('prepends the compact date prefix', () => {
      expect(renderDatedSnippet('2026-06-09T08:00:00Z', 'shipped the lane')).toBe('[2026-06-09] shipped the lane');
    });

    it('falls back to the bare text without a usable timestamp', () => {
      expect(renderDatedSnippet(null, 'undated fact')).toBe('undated fact');
    });
  });

  describe('referenceDate', () => {
    it('returns the max date among the supplied timestamps', () => {
      expect(referenceDate(['2026-06-01', '2026-06-09T10:00:00Z', '2025-12-31'])).toBe('2026-06-09');
    });

    it('skips unusable values', () => {
      expect(referenceDate([null, undefined, '', '2026-06-02'])).toBe('2026-06-02');
    });

    it('returns null when nothing carries a date', () => {
      expect(referenceDate([null, undefined, ''])).toBeNull();
    });
  });

  describe('renderReferenceDateLine', () => {
    it('builds the anchor line from the most recent date', () => {
      expect(renderReferenceDateLine(['2026-06-01', '2026-06-09'])).toBe(
        'Reference date (most recent memory): 2026-06-09',
      );
    });

    it('returns null when no date is available', () => {
      expect(renderReferenceDateLine([null, undefined])).toBeNull();
    });
  });
});

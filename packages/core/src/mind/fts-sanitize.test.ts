import { describe, it, expect } from 'vitest';
import {
  FTS_STOP_WORDS,
  sanitizeFtsToken,
  hasUnsegmentedScript,
  buildFtsOrQuery,
} from './fts-sanitize.js';

/**
 * S1 — Unicode FTS sanitizer. The legacy `[^\w]` strip destroyed every
 * non-ASCII letter; the shared helper must preserve Cyrillic/diacritics,
 * exclude CJK (unsegmented by unicode61), and stay byte-identical to the
 * legacy pipeline for pure-ASCII queries (LoCoMo invariance).
 */

/** Verbatim copy of the legacy sanitizer (search.ts W3.6 / raw-detail-lane). */
function legacyFtsOrQuery(query: string): string {
  return query
    .split(/\s+/)
    .map(w => w.replace(/[^\w]/g, ''))
    .filter(w => w.length > 2 && !FTS_STOP_WORDS.has(w.toLowerCase()))
    .map(w => `"${w.replace(/"/g, '')}"`)
    .join(' OR ');
}

describe('fts-sanitize (S1)', () => {
  describe('sanitizeFtsToken', () => {
    it('is a no-op strip for ASCII words (identical to [^\\w])', () => {
      for (const w of ['hello', 'world_2', 'GPT4', 'machine-learning,', '"quoted"']) {
        expect(sanitizeFtsToken(w)).toBe(w.replace(/[^\w]/g, ''));
      }
    });

    it('preserves Cyrillic letters', () => {
      expect(sanitizeFtsToken('Београд,')).toBe('Београд');
    });

    it('preserves Latin diacritics', () => {
      expect(sanitizeFtsToken('čokolada!')).toBe('čokolada');
      expect(sanitizeFtsToken('žurka')).toBe('žurka');
    });

    it('strips emoji and punctuation', () => {
      expect(sanitizeFtsToken('🚀!!')).toBe('');
      expect(sanitizeFtsToken('a🚀b')).toBe('ab');
    });
  });

  describe('hasUnsegmentedScript', () => {
    it('detects Han, Hiragana, Katakana, Hangul', () => {
      expect(hasUnsegmentedScript('北京')).toBe(true);
      expect(hasUnsegmentedScript('ひらがな')).toBe(true);
      expect(hasUnsegmentedScript('カタカナ')).toBe(true);
      expect(hasUnsegmentedScript('한국어')).toBe(true);
      expect(hasUnsegmentedScript('meeting 北京')).toBe(true);
    });

    it('is false for ASCII, Cyrillic, and diacritics', () => {
      expect(hasUnsegmentedScript('meeting notes')).toBe(false);
      expect(hasUnsegmentedScript('Београд')).toBe(false);
      expect(hasUnsegmentedScript('čačak žurka')).toBe(false);
    });
  });

  describe('buildFtsOrQuery', () => {
    it('is byte-identical to the legacy sanitizer for English queries (regression lock)', () => {
      const representative = [
        'machine learning',
        'quantum computing spacetime',
        'hiring decisions this month',
        'the a an of to in for on with',
        'What did we decide about the deployment?',
        'error-handling in production!',
        'TypeScript preferences',
        'launch date',
        'API design patterns REST GraphQL and gRPC services',
        'ab cd ef',
        'a1 b2c3 d_4',
      ];
      for (const q of representative) {
        expect(buildFtsOrQuery(q)).toBe(legacyFtsOrQuery(q));
      }
    });

    it('keeps Cyrillic tokens', () => {
      expect(buildFtsOrQuery('Београд конференција')).toBe('"Београд" OR "конференција"');
    });

    it('keeps diacritic tokens', () => {
      expect(buildFtsOrQuery('čokolada žurka')).toBe('"čokolada" OR "žurka"');
    });

    it('drops short (≤2 char) tokens regardless of script', () => {
      expect(buildFtsOrQuery('је Београд')).toBe('"Београд"');
    });

    it('returns empty for pure-CJK queries (routed to LIKE by callers)', () => {
      expect(buildFtsOrQuery('北京旅行')).toBe('');
      expect(buildFtsOrQuery('ひらがなのテスト')).toBe('');
    });

    it('drops CJK tokens from mixed queries but keeps the rest', () => {
      expect(buildFtsOrQuery('会議 meeting notes')).toBe('"meeting" OR "notes"');
    });

    it('returns empty for stop-word-only and punctuation-only queries', () => {
      expect(buildFtsOrQuery('the a an')).toBe('');
      expect(buildFtsOrQuery('!!! ???')).toBe('');
    });
  });
});

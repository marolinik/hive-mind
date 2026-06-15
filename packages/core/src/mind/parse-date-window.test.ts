// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
import { describe, it, expect } from 'vitest';
import { parseDateWindow } from './parse-date-window.js';

/**
 * Query-side date-window parser (production port of the Wave-3.1 benchmark
 * parser, validated on the full N=1540 LoCoMo run). Shapes below mirror the
 * mined failure cases the benchmark lane was built against.
 */

describe('parseDateWindow', () => {
  it('parses "last week of <month> <year>"', () => {
    const w = parseDateWindow('Where was Calvin in the last week of October 2023?');
    expect(w).toEqual({ since: '2023-10-25', until: '2023-10-31', label: 'the last week of october 2023' });
  });

  it('parses "first week of <month> <year>"', () => {
    const w = parseDateWindow('events in the first week of May 2023');
    expect(w).toEqual({ since: '2023-05-01', until: '2023-05-07', label: 'the first week of may 2023' });
  });

  it('parses "early <month> <year>"', () => {
    const w = parseDateWindow('What happened in early June 2023?');
    expect(w).toEqual({ since: '2023-06-01', until: '2023-06-10', label: 'early june 2023' });
  });

  it('parses "<day> <month> <year>" with a ±2-day buffer', () => {
    const w = parseDateWindow('What painting did Melanie show on 13 October 2023?');
    expect(w).toEqual({ since: '2023-10-11', until: '2023-10-15', label: '13 october 2023' });
  });

  it('parses "<month> <day>, <year>" (US order) with a ±2-day buffer', () => {
    const w = parseDateWindow('What did Mel paint on October 13, 2023?');
    expect(w).toEqual({ since: '2023-10-11', until: '2023-10-15', label: '13 october 2023' });
  });

  it('parses bare "<month> <year>" as the whole month', () => {
    const w = parseDateWindow('their latest project in July 2023');
    expect(w).toEqual({ since: '2023-07-01', until: '2023-07-31', label: 'july 2023' });
  });

  it('handles February month-length correctly', () => {
    expect(parseDateWindow('in February 2024')?.until).toBe('2024-02-29'); // leap
    expect(parseDateWindow('in February 2023')?.until).toBe('2023-02-28');
  });

  it('parses "in <year>" as the whole year (requires in/during)', () => {
    const w = parseDateWindow('What did we decide in 2022?');
    expect(w).toEqual({ since: '2022-01-01', until: '2022-12-31', label: '2022' });
  });

  it('does NOT window a bare year without in/during (ids, names)', () => {
    expect(parseDateWindow('open ticket 2024 about the login flow')).toBeNull();
  });

  it('does NOT window relative phrases (write-side concern)', () => {
    expect(parseDateWindow('what did we decide last week?')).toBeNull();
    expect(parseDateWindow('two months ago we shipped something')).toBeNull();
  });

  it('returns null for queries with no temporal constraint', () => {
    expect(parseDateWindow('favorite painting colors')).toBeNull();
  });
});

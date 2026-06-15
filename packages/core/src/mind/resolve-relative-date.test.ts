// Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
import { describe, it, expect } from 'vitest';
import { resolveRelativeDate } from './resolve-relative-date.js';

describe('resolveRelativeDate', () => {
  // Reference: 2023-05-08 is a Monday.
  const REF = '2023-05-08';

  it('resolves the canonical benchmark case (conv-26 q000)', () => {
    // "I went to a LGBTQ support group yesterday" said on 2023-05-08 → event 2023-05-07.
    const r = resolveRelativeDate('I went to a LGBTQ support group yesterday and it was powerful.', REF);
    expect(r).toEqual({ cue: 'yesterday', iso: '2023-05-07' });
  });

  it('resolves "the day before yesterday" before "yesterday"', () => {
    const r = resolveRelativeDate('We met the day before yesterday.', REF);
    expect(r).toEqual({ cue: 'the day before yesterday', iso: '2023-05-06' });
  });

  it('resolves "N days ago"', () => {
    expect(resolveRelativeDate('finished it 3 days ago', REF)).toEqual({ cue: '3 days ago', iso: '2023-05-05' });
  });

  it('resolves "last week" as −7 days', () => {
    expect(resolveRelativeDate('ran a race last week', REF)).toEqual({ cue: 'last week', iso: '2023-05-01' });
  });

  it('resolves "N weeks ago"', () => {
    expect(resolveRelativeDate('started 2 weeks ago', REF)).toEqual({ cue: '2 weeks ago', iso: '2023-04-24' });
  });

  it('resolves "last month" with month arithmetic', () => {
    expect(resolveRelativeDate('moved house last month', REF)).toEqual({ cue: 'last month', iso: '2023-04-08' });
  });

  it('resolves "N months ago"', () => {
    expect(resolveRelativeDate('quit 2 months ago', REF)).toEqual({ cue: '2 months ago', iso: '2023-03-08' });
  });

  it('resolves "last year" (Memori worked example: 4 May 2022 + "last year" → 2021)', () => {
    expect(resolveRelativeDate('we went to India last year', '2022-05-04')).toEqual({ cue: 'last year', iso: '2021-05-04' });
  });

  it('resolves "last <weekday>" to the most recent prior occurrence', () => {
    // REF 2023-05-08 is Monday; "last Friday" = 2023-05-05.
    expect(resolveRelativeDate('went to a meeting last Friday', REF)).toEqual({ cue: 'last friday', iso: '2023-05-05' });
    // "last Monday" from a Monday → the previous Monday (strictly before), 2023-05-01.
    expect(resolveRelativeDate('it happened last Monday', REF)).toEqual({ cue: 'last monday', iso: '2023-05-01' });
  });

  it('handles month-end clamp (Mar 31 − 1 month → Feb 28, not Mar 3)', () => {
    expect(resolveRelativeDate('it was last month', '2023-03-31')).toEqual({ cue: 'last month', iso: '2023-02-28' });
  });

  it('accepts a datetime reference, not just a date', () => {
    expect(resolveRelativeDate('yesterday', '2023-05-08T13:56:00Z')).toEqual({ cue: 'yesterday', iso: '2023-05-07' });
  });

  it('returns null when there is no relative cue', () => {
    expect(resolveRelativeDate('Caroline values self-acceptance.', REF)).toBeNull();
    expect(resolveRelativeDate('I am playing Cyberpunk 2077 right now', REF)).toBeNull();
  });

  it('returns null on an unusable reference date', () => {
    expect(resolveRelativeDate('yesterday', null)).toBeNull();
    expect(resolveRelativeDate('yesterday', 'not-a-date')).toBeNull();
    expect(resolveRelativeDate('yesterday', undefined)).toBeNull();
  });

  it('returns null on empty text', () => {
    expect(resolveRelativeDate('', REF)).toBeNull();
  });

  it('does not match relative cues embedded in unrelated words', () => {
    expect(resolveRelativeDate('he messaged me', REF)).toBeNull();
  });
});

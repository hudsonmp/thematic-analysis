import { describe, it, expect } from 'vitest';
import { ANCHOR_CORRECTION_MS, computeAnchorMs } from '@/lib/live/anchor';

describe('ANCHOR_CORRECTION_MS', () => {
  it('is the single 2000ms record-start correction constant', () => {
    expect(ANCHOR_CORRECTION_MS).toBe(2000);
  });
});

describe('computeAnchorMs', () => {
  it('returns the task module_start epoch-ms plus the +2000ms correction', () => {
    // A known instant: 2026-06-11T15:53:02.197Z → epoch-ms, then +2000.
    const iso = '2026-06-11T15:53:02.197Z';
    const baseMs = Date.parse(iso);
    expect(computeAnchorMs(iso)).toBe(baseMs + 2000);
  });

  it('applies exactly ANCHOR_CORRECTION_MS (not a hardcoded literal)', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    expect(computeAnchorMs(iso) - Date.parse(iso)).toBe(ANCHOR_CORRECTION_MS);
  });

  it('parses a Postgres timestamptz with a +00 offset to the same instant', () => {
    // The DB hands back `...+00`; it must parse to the same epoch as the Z form.
    const pg = '2026-06-11 15:53:02.197+00';
    const z = '2026-06-11T15:53:02.197Z';
    expect(computeAnchorMs(pg)).toBe(computeAnchorMs(z));
  });

  it('throws on an unparseable timestamp rather than returning NaN', () => {
    expect(() => computeAnchorMs('not-a-timestamp')).toThrow(/unparseable/);
  });
});

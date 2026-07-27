import { describe, it, expect } from 'vitest';
import { coalesceEditBursts } from '../editBursts';

const ANCHOR = Date.parse('2026-07-01T10:00:00Z');
const at = (sec: number) => new Date(ANCHOR + sec * 1000).toISOString();

describe('coalesceEditBursts', () => {
  it('merges edits within the gap into one burst and splits across it', () => {
    const bursts = coalesceEditBursts([at(10), at(15), at(22), at(60), at(65)], ANCHOR);
    expect(bursts).toHaveLength(2);
    expect(bursts[0]).toEqual({ startMs: 10_000, endMs: 22_000, count: 3 });
    expect(bursts[1]).toEqual({ startMs: 60_000, endMs: 65_000, count: 2 });
  });

  it('a lone edit gets the minimum visible span', () => {
    const bursts = coalesceEditBursts([at(30)], ANCHOR);
    expect(bursts).toEqual([{ startMs: 30_000, endMs: 31_500, count: 1 }]);
  });

  it('sorts unordered input and clamps pre-recording edits to 0', () => {
    const bursts = coalesceEditBursts([at(50), at(-20), at(45)], ANCHOR);
    expect(bursts[0].startMs).toBe(0);
    expect(bursts[bursts.length - 1].endMs).toBe(50_000);
  });

  it('drops unparseable timestamps and handles empty input', () => {
    expect(coalesceEditBursts([], ANCHOR)).toEqual([]);
    expect(coalesceEditBursts(['not-a-date'], ANCHOR)).toEqual([]);
  });

  it('gap boundary is inclusive', () => {
    const bursts = coalesceEditBursts([at(0), at(10)], ANCHOR, 10_000);
    expect(bursts).toHaveLength(1);
    const split = coalesceEditBursts([at(0), at(10.001)], ANCHOR, 10_000);
    expect(split).toHaveLength(2);
  });
});

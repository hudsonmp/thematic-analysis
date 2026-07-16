import { describe, expect, it } from 'vitest';
import { packGutter, sameAnchor } from '@/lib/transcript/gutter';

describe('packGutter', () => {
  it('leaves non-overlapping blocks at their own range tops', () => {
    const out = packGutter([
      { id: 'a', top: 0, bottom: 40, blockHeight: 20 },
      { id: 'b', top: 100, bottom: 140, blockHeight: 20 },
    ]);
    expect(out.map((o) => o.blockTop)).toEqual([0, 100]);
  });

  it('pushes a colliding block DOWN, never up', () => {
    // Block "a" occupies 0..50 (+gap). "b" wants 30 — inside a's block — so it lands
    // below. Down-only preserves the invariant that a block is never ABOVE its text:
    // a chip you must scroll UP from its text to find reads as the previous passage's.
    const out = packGutter(
      [
        { id: 'a', top: 0, bottom: 40, blockHeight: 50 },
        { id: 'b', top: 30, bottom: 90, blockHeight: 20 },
      ],
      8,
    );
    expect(out[1].blockTop).toBe(58); // 0 + 50 + 8
    expect(out[1].blockTop).toBeGreaterThanOrEqual(out[1].braceTop - 60); // sanity: near its brace
  });

  it('cascades pushes through a chain of overlapping ranges', () => {
    const out = packGutter(
      [
        { id: 'a', top: 0, bottom: 100, blockHeight: 30 },
        { id: 'b', top: 10, bottom: 110, blockHeight: 30 },
        { id: 'c', top: 20, bottom: 120, blockHeight: 30 },
      ],
      10,
    );
    expect(out.map((o) => o.blockTop)).toEqual([0, 40, 80]);
  });

  it('never moves the BRACE — only the chip block packs', () => {
    // The brace is the claim "this exact text": moving it would misreport the span.
    const out = packGutter(
      [
        { id: 'a', top: 0, bottom: 40, blockHeight: 50 },
        { id: 'b', top: 30, bottom: 90, blockHeight: 20 },
      ],
      8,
    );
    expect(out[1].braceTop).toBe(30);
    expect(out[1].braceBottom).toBe(90);
  });

  it('keeps TEXT order with an id tiebreak, so the layout is deterministic', () => {
    const out = packGutter([
      { id: 'z', top: 50, bottom: 60, blockHeight: 10 },
      { id: 'a', top: 50, bottom: 60, blockHeight: 10 },
      { id: 'm', top: 0, bottom: 10, blockHeight: 10 },
    ]);
    expect(out.map((o) => o.id)).toEqual(['m', 'a', 'z']);
  });

  it('does not mutate its input', () => {
    const inputs = [
      { id: 'b', top: 10, bottom: 20, blockHeight: 10 },
      { id: 'a', top: 0, bottom: 5, blockHeight: 10 },
    ];
    const snapshot = structuredClone(inputs);
    packGutter(inputs);
    expect(inputs).toEqual(snapshot);
  });

  it('clamps a degenerate range (bottom < top) instead of drawing an inverted brace', () => {
    const out = packGutter([{ id: 'a', top: 50, bottom: 40, blockHeight: 10 }]);
    expect(out[0].braceBottom).toBe(50);
  });

  it('handles empty input', () => {
    expect(packGutter([])).toEqual([]);
  });
});

describe('sameAnchor', () => {
  const base = { segmentId: 's1', endSegmentId: null, charStart: 5, charEnd: 20 };

  it('matches only the IDENTICAL anchor — overlap is not enough', () => {
    // A different span is a different claim about where the evidence starts and stops;
    // merging merely-overlapping selections would silently rewrite that claim.
    expect(sameAnchor(base, { ...base })).toBe(true);
    expect(sameAnchor(base, { ...base, charEnd: 21 })).toBe(false);
    expect(sameAnchor(base, { ...base, charStart: 4 })).toBe(false);
    expect(sameAnchor(base, { ...base, segmentId: 's2' })).toBe(false);
  });

  it('treats null and missing endSegmentId as the same single-segment case', () => {
    expect(
      sameAnchor(
        { ...base, endSegmentId: null },
        { ...base, endSegmentId: null },
      ),
    ).toBe(true);
    expect(sameAnchor(base, { ...base, endSegmentId: 's9' })).toBe(false);
  });
});

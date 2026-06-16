import { describe, it, expect } from 'vitest';
import { orderByTime, type OrderableCue } from '../order';

const cue = (idx: number, startMs: number): OrderableCue => ({ idx, startMs });

describe('orderByTime', () => {
  it('sorts by startMs ascending', () => {
    const out = orderByTime([cue(0, 3000), cue(1, 1000), cue(2, 2000)]);
    expect(out.map((c) => c.idx)).toEqual([1, 2, 0]);
  });

  it('reorders the multi-track interleave into temporal order', () => {
    // Block order clusters by speaker: David blob (idx 0), then participant phrases
    // (idx 1..3), then David again (idx 4). Temporal order interleaves them by start.
    const blockOrder = [
      cue(0, 70), // David — 80s blob, starts first
      cue(1, 3750), // phrase
      cue(2, 13770), // phrase
      cue(3, 71640), // phrase
      cue(4, 79640), // David again
    ];
    // Already temporally ascending here → identity, but the property is start-order.
    expect(orderByTime(blockOrder).map((c) => c.startMs)).toEqual([
      70, 3750, 13770, 71640, 79640,
    ]);
  });

  it('places an interjection between the phrases it interrupts', () => {
    // Participant phrases at 1000 and 3000; researcher interjects at 2000. In block
    // order the interjection may be appended last; temporal order slots it between.
    const blockOrder = [cue(0, 1000), cue(1, 3000), cue(2, 2000)];
    expect(orderByTime(blockOrder).map((c) => c.idx)).toEqual([0, 2, 1]);
  });

  it('breaks startMs ties by idx (stable, original file order)', () => {
    const out = orderByTime([cue(5, 1000), cue(2, 1000), cue(9, 1000)]);
    expect(out.map((c) => c.idx)).toEqual([2, 5, 9]);
  });

  it('does not mutate the input array', () => {
    const input = [cue(0, 3000), cue(1, 1000)];
    const copy = [...input];
    orderByTime(input);
    expect(input).toEqual(copy);
  });

  it('returns [] for []', () => {
    expect(orderByTime([])).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { findActiveIndex, nearestCueIndex, type TimedCue } from '../active';

// Models the real multi-track hazard: a long track-level cue (an 80s "interjection")
// temporally containing several short phrase cues from the other speaker.
const MULTI: TimedCue[] = [
  { startMs: 70, endMs: 79640 }, // 0: David — 80s track blob
  { startMs: 3750, endMs: 13770 }, // 1: phrase
  { startMs: 13770, endMs: 20010 }, // 2: phrase
  { startMs: 26820, endMs: 31400 }, // 3: phrase (note 20010..26820 gap)
];

describe('findActiveIndex (tightest containing)', () => {
  it('returns -1 for an empty transcript', () => {
    expect(findActiveIndex([], 1000)).toBe(-1);
  });

  it('returns -1 when no cue contains the time (a gap)', () => {
    const single: TimedCue[] = [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3000 }];
    expect(findActiveIndex(single, 1500)).toBe(-1);
  });

  it('picks the TIGHTEST containing cue, not the first (the multi-track bug)', () => {
    // 8000ms is inside cue 0 (70..79640) AND cue 1 (3750..13770). The phrase (1) is
    // tighter than the 80s blob (0), so it wins — the old "first containing" returned 0.
    expect(findActiveIndex(MULTI, 8000)).toBe(1);
    expect(findActiveIndex(MULTI, 15000)).toBe(2); // inside 0 and 2 → tighter 2
    expect(findActiveIndex(MULTI, 28000)).toBe(3); // inside 0 and 3 → tighter 3
  });

  it('falls onto the blob only when no tighter cue contains the time', () => {
    // 2000ms: only cue 0 contains it (phrase 1 starts at 3750).
    expect(findActiveIndex(MULTI, 2000)).toBe(0);
    // 22000ms: inside the 20010..26820 phrase gap, but still inside cue 0.
    expect(findActiveIndex(MULTI, 22000)).toBe(0);
  });

  it('breaks span ties toward the earlier cue', () => {
    const tie: TimedCue[] = [
      { startMs: 0, endMs: 100 },
      { startMs: 0, endMs: 100 },
    ];
    expect(findActiveIndex(tie, 50)).toBe(0);
  });

  it('treats endMs as exclusive', () => {
    const c: TimedCue[] = [{ startMs: 0, endMs: 1000 }];
    expect(findActiveIndex(c, 999)).toBe(0);
    expect(findActiveIndex(c, 1000)).toBe(-1);
  });
});

describe('nearestCueIndex (containing, else nearest by gap)', () => {
  it('returns -1 only for an empty transcript', () => {
    expect(nearestCueIndex([], 1000)).toBe(-1);
  });

  it('matches findActiveIndex when a cue contains the time (tightest)', () => {
    expect(nearestCueIndex(MULTI, 8000)).toBe(1);
    expect(nearestCueIndex(MULTI, 28000)).toBe(3);
  });

  it('attaches a gap-falling time to the nearest cue by time distance', () => {
    const single: TimedCue[] = [
      { startMs: 0, endMs: 1000 }, // gap to end at 1300 = 300
      { startMs: 2000, endMs: 3000 }, // gap to start at 1300 = 700
    ];
    expect(nearestCueIndex(single, 1300)).toBe(0); // closer to cue 0's end
    expect(nearestCueIndex(single, 1800)).toBe(1); // closer to cue 1's start
  });

  it('attaches a time before all cues to the first, after all cues to the last', () => {
    const single: TimedCue[] = [
      { startMs: 1000, endMs: 2000 },
      { startMs: 3000, endMs: 4000 },
    ];
    expect(nearestCueIndex(single, 0)).toBe(0);
    expect(nearestCueIndex(single, 9999)).toBe(1);
  });
});

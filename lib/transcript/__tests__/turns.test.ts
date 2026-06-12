import { describe, it, expect } from 'vitest';
import { groupIntoTurns, type TurnSegment } from '../turns';

/** Build a segment with distinct ms values derived from the index so
 *  startMs/endMs assertions are unambiguous. */
function seg(i: number, speaker: string | null): TurnSegment {
  return {
    id: `s${i}`,
    startMs: i * 1000,
    endMs: i * 1000 + 500,
    speaker,
    text: `line ${i}`,
  };
}

describe('groupIntoTurns', () => {
  it('merges three consecutive same-speaker segments into one turn', () => {
    const turns = groupIntoTurns([seg(0, 'A'), seg(1, 'A'), seg(2, 'A')]);
    expect(turns).toHaveLength(1);
    expect(turns[0].speaker).toBe('A');
    expect(turns[0].segIndices).toEqual([0, 1, 2]);
  });

  it('breaks A→A→B→B→A into three turns', () => {
    const turns = groupIntoTurns([
      seg(0, 'A'),
      seg(1, 'A'),
      seg(2, 'B'),
      seg(3, 'B'),
      seg(4, 'A'),
    ]);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.speaker)).toEqual(['A', 'B', 'A']);
    expect(turns.map((t) => t.segIndices)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('returns one turn for a single segment', () => {
    const turns = groupIntoTurns([seg(0, 'A')]);
    expect(turns).toHaveLength(1);
    expect(turns[0].speaker).toBe('A');
    expect(turns[0].segIndices).toEqual([0]);
  });

  it('groups all-null speakers (single-track) into one turn', () => {
    const turns = groupIntoTurns([seg(0, null), seg(1, null), seg(2, null)]);
    expect(turns).toHaveLength(1);
    expect(turns[0].speaker).toBeNull();
    expect(turns[0].segIndices).toEqual([0, 1, 2]);
  });

  it('treats null as its own speaker: A→null→A is three turns', () => {
    const turns = groupIntoTurns([seg(0, 'A'), seg(1, null), seg(2, 'A')]);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.speaker)).toEqual(['A', null, 'A']);
    expect(turns.map((t) => t.segIndices)).toEqual([[0], [1], [2]]);
  });

  it('returns [] for empty input', () => {
    expect(groupIntoTurns([])).toEqual([]);
  });

  it('takes startMs/endMs from the first/last cue of each turn', () => {
    // Distinct ms values so the first-start / last-end choice is observable.
    const segments: TurnSegment[] = [
      { id: 'a', startMs: 100, endMs: 200, speaker: 'A', text: 'one' },
      { id: 'b', startMs: 300, endMs: 400, speaker: 'A', text: 'two' },
      { id: 'c', startMs: 500, endMs: 600, speaker: 'A', text: 'three' },
      { id: 'd', startMs: 700, endMs: 800, speaker: 'B', text: 'four' },
    ];
    const turns = groupIntoTurns(segments);
    expect(turns).toHaveLength(2);
    // Turn 1: first cue start (100), last cue end (600).
    expect(turns[0].startMs).toBe(100);
    expect(turns[0].endMs).toBe(600);
    // Turn 2: single cue.
    expect(turns[1].startMs).toBe(700);
    expect(turns[1].endMs).toBe(800);
  });
});

import { describe, it, expect } from 'vitest';
import {
  episodeIndexAt,
  isRetroEpisodeName,
  retroSkipTarget,
  type EpisodeMark,
} from '../retroSkip';

/** A session shaped like the real ones: work, a scenario retrospective, more
 *  work, then the three general retrospective questions to close. */
const marks: EpisodeMark[] = [
  { tStartMs: 0, name: 'Requirements Analysis' },
  { tStartMs: 10_000, name: 'Writing Specification from Requirements' },
  { tStartMs: 20_000, name: 'Scenario Retrospective' },
  { tStartMs: 30_000, name: 'New Scenario Introduced' },
  { tStartMs: 40_000, name: 'Editing Specification' },
  { tStartMs: 50_000, name: 'General Retrospective Question I' },
  { tStartMs: 60_000, name: 'General Retrospective Question II' },
  { tStartMs: 70_000, name: 'General Retrospective Question III' },
];

describe('isRetroEpisodeName', () => {
  it('matches every canonical retrospective phase and nothing else', () => {
    expect(marks.filter((m) => isRetroEpisodeName(m.name)).map((m) => m.tStartMs)).toEqual([
      20_000, 50_000, 60_000, 70_000,
    ]);
  });
});

describe('episodeIndexAt', () => {
  it('is -1 before the first mark', () => {
    expect(episodeIndexAt([{ tStartMs: 5_000, name: 'Requirements Analysis' }], 0)).toBe(-1);
  });

  it('takes the last mark whose start has passed, boundary inclusive', () => {
    expect(episodeIndexAt(marks, 19_999)).toBe(1);
    expect(episodeIndexAt(marks, 20_000)).toBe(2);
    expect(episodeIndexAt(marks, 99_000)).toBe(7);
  });

  it('has nothing to say about a session with no marks', () => {
    expect(episodeIndexAt([], 42)).toBe(-1);
  });
});

describe('retroSkipTarget', () => {
  it('leaves the playhead alone outside a retrospective', () => {
    expect(retroSkipTarget(marks, 0)).toBeNull();
    expect(retroSkipTarget(marks, 19_999)).toBeNull();
    expect(retroSkipTarget(marks, 45_000)).toBeNull();
  });

  it('leaves the playhead alone before the first mark, and with no marks at all', () => {
    expect(retroSkipTarget(marks, -1)).toBeNull();
    expect(retroSkipTarget([], 25_000)).toBeNull();
  });

  it('jumps a mid-session retrospective to the next working episode', () => {
    expect(retroSkipTarget(marks, 20_000)).toEqual({ kind: 'jump', toMs: 30_000 });
    expect(retroSkipTarget(marks, 29_999)).toEqual({ kind: 'jump', toMs: 30_000 });
  });

  it('clears CONSECUTIVE retrospectives in one jump, not one question at a time', () => {
    const trailing: EpisodeMark[] = [
      ...marks.slice(0, 5),
      { tStartMs: 50_000, name: 'General Retrospective Question I' },
      { tStartMs: 60_000, name: 'General Retrospective Question II' },
      { tStartMs: 70_000, name: 'Editing Specification' },
    ];
    expect(retroSkipTarget(trailing, 52_000)).toEqual({ kind: 'jump', toMs: 70_000 });
  });

  it('parks at the end when every remaining episode is retrospective', () => {
    // The work is over — playing the tail out is exactly what skipping is for.
    expect(retroSkipTarget(marks, 50_000)).toEqual({ kind: 'end' });
    expect(retroSkipTarget(marks, 71_000)).toEqual({ kind: 'end' });
  });
});

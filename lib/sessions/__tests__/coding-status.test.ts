import { describe, it, expect } from 'vitest';
import { mergeDoneSet, type SessionRowWithoutDone } from '../coding-status';

const row = (id: string): SessionRowWithoutDone => ({
  id,
  pidLabel: `P-${id}`,
  collection: 'study',
  durationMs: 1000,
  trackMode: 'single',
});

describe('mergeDoneSet', () => {
  it('flags only the rows whose id is in the done-set', () => {
    const rows = [row('a'), row('b'), row('c')];
    const out = mergeDoneSet(rows, new Set(['a', 'c']));
    expect(out.map((r) => [r.id, r.done])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
  });

  it('flags every row false when the coder has marked nothing', () => {
    const rows = [row('a'), row('b')];
    const out = mergeDoneSet(rows, new Set());
    expect(out.every((r) => r.done === false)).toBe(true);
  });

  it('preserves every other field unchanged', () => {
    const [r] = mergeDoneSet([row('a')], new Set(['a']));
    expect(r).toEqual({
      id: 'a',
      pidLabel: 'P-a',
      collection: 'study',
      durationMs: 1000,
      trackMode: 'single',
      done: true,
    });
  });

  it('ignores done-set ids that match no row', () => {
    const out = mergeDoneSet([row('a')], new Set(['a', 'ghost']));
    expect(out).toHaveLength(1);
    expect(out[0].done).toBe(true);
  });

  it('returns a new array and does not mutate the input rows', () => {
    const rows = [row('a')];
    const out = mergeDoneSet(rows, new Set(['a']));
    expect(out).not.toBe(rows);
    expect(rows[0]).not.toHaveProperty('done');
  });

  it('returns an empty array for empty input', () => {
    expect(mergeDoneSet([], new Set(['a']))).toEqual([]);
  });
});

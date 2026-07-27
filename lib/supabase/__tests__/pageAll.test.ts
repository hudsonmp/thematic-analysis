import { describe, it, expect } from 'vitest';
import { pageAll, PAGE } from '../pageAll';

const dataset = (n: number) => Array.from({ length: n }, (_, i) => i);

const fakePager = (rows: number[], calls: [number, number][] = []) =>
  (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
  };

describe('pageAll', () => {
  it('drains a multi-page list completely and in order', async () => {
    const rows = dataset(2500);
    const calls: [number, number][] = [];
    const { data, error } = await pageAll(fakePager(rows, calls));
    expect(error).toBeNull();
    expect(data).toEqual(rows);
    expect(calls).toEqual([
      [0, PAGE - 1],
      [PAGE, 2 * PAGE - 1],
      [2 * PAGE, 3 * PAGE - 1],
    ]);
  });

  it('a single short page terminates after one call', async () => {
    const calls: [number, number][] = [];
    const { data } = await pageAll(fakePager(dataset(42), calls));
    expect(data).toHaveLength(42);
    expect(calls).toHaveLength(1);
  });

  it('an exact-multiple list needs one extra empty page to prove the end', async () => {
    const calls: [number, number][] = [];
    const { data } = await pageAll(fakePager(dataset(PAGE), calls));
    expect(data).toHaveLength(PAGE);
    expect(calls).toHaveLength(2);
  });

  it('empty list → empty data, no error', async () => {
    const { data, error } = await pageAll(fakePager([]));
    expect(data).toEqual([]);
    expect(error).toBeNull();
  });

  it('propagates a mid-drain error with the rows gathered so far', async () => {
    let n = 0;
    const { data, error } = await pageAll<number>((from, to) => {
      n++;
      if (n === 2) return Promise.resolve({ data: null, error: { message: 'boom' } });
      return Promise.resolve({ data: dataset(3000).slice(from, to + 1), error: null });
    });
    expect(error?.message).toBe('boom');
    expect(data).toHaveLength(PAGE);
  });
});

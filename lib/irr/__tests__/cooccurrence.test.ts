import { describe, it, expect } from 'vitest';
import { codeCooccurrence, mergeCandidates, type UnitCode } from '../cooccurrence';

const uc = (unit: number, code: string): UnitCode => ({ unit, code });

describe('codeCooccurrence', () => {
  it('diagonal is 1 and self-count is the unit count', () => {
    const co = codeCooccurrence(10, [uc(0, 'X'), uc(1, 'X'), uc(2, 'X')]);
    const i = co.codes.indexOf('X');
    expect(co.matrix[i][i]).toBe(1);
    expect(co.counts[i][i]).toBe(3);
    expect(co.unitCount[i]).toBe(3);
  });

  it('two codes on identical units → φ = 1', () => {
    const co = codeCooccurrence(10, [
      uc(0, 'A'), uc(1, 'A'), uc(2, 'A'),
      uc(0, 'B'), uc(1, 'B'), uc(2, 'B'),
    ]);
    const a = co.codes.indexOf('A');
    const b = co.codes.indexOf('B');
    expect(co.matrix[a][b]).toBeCloseTo(1, 6);
    expect(co.counts[a][b]).toBe(3);
  });

  it('two codes on disjoint units → negative φ', () => {
    const co = codeCooccurrence(10, [
      uc(0, 'A'), uc(1, 'A'),
      uc(5, 'B'), uc(6, 'B'),
    ]);
    const a = co.codes.indexOf('A');
    const b = co.codes.indexOf('B');
    expect(co.matrix[a][b]!).toBeLessThan(0);
    expect(co.counts[a][b]).toBe(0);
  });

  it('a code on every unit has no variance → φ null (blank cell)', () => {
    const pooled: UnitCode[] = [];
    for (let u = 0; u < 5; u++) pooled.push(uc(u, 'ALL'));
    pooled.push(uc(0, 'RARE'), uc(1, 'RARE'));
    const co = codeCooccurrence(5, pooled);
    const all = co.codes.indexOf('ALL');
    const rare = co.codes.indexOf('RARE');
    expect(co.matrix[all][rare]).toBeNull();
  });

  it('codeFilter restricts the axes', () => {
    const co = codeCooccurrence(
      10,
      [uc(0, 'A'), uc(1, 'B'), uc(2, 'C')],
      { codeFilter: ['A', 'C'] },
    );
    expect(co.codes.sort()).toEqual(['A', 'C']);
  });

  it('is symmetric', () => {
    const co = codeCooccurrence(8, [
      uc(0, 'A'), uc(1, 'A'), uc(2, 'A'),
      uc(1, 'B'), uc(2, 'B'), uc(4, 'B'),
    ]);
    for (let i = 0; i < co.codes.length; i++)
      for (let j = 0; j < co.codes.length; j++)
        expect(co.matrix[i][j]).toBe(co.matrix[j][i]);
  });
});

describe('mergeCandidates', () => {
  const co = codeCooccurrence(10, [
    // A and B co-occur strongly (units 0,1,2), C is elsewhere.
    uc(0, 'A'), uc(1, 'A'), uc(2, 'A'),
    uc(0, 'B'), uc(1, 'B'), uc(2, 'B'),
    uc(7, 'C'), uc(8, 'C'),
  ]);

  it('flags a highly-correlated pair with weak agreement', () => {
    const flags = mergeCandidates(co, { A: 0.3, B: 0.4, C: 0.9 });
    expect(flags.some((f) => (f.a === 'A' && f.b === 'B') || (f.a === 'B' && f.b === 'A'))).toBe(true);
  });

  it('does NOT flag a highly-correlated pair that agrees well', () => {
    const flags = mergeCandidates(co, { A: 0.9, B: 0.9, C: 0.9 });
    expect(flags.length).toBe(0);
  });

  it('treats a null (uncertifiable) κ as weak', () => {
    const flags = mergeCandidates(co, { A: null, B: 0.9, C: 0.9 });
    expect(flags.some((f) => f.a === 'A' || f.b === 'A')).toBe(true);
  });
});

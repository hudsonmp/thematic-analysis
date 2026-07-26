import { describe, it, expect } from 'vitest';
import {
  cardTypeFor,
  pickDistractors,
  exemplarFor,
  buildQueue,
  mulberry32,
  hashSeed,
  type DrillCode,
} from '../cards';

const code = (
  id: string,
  opts: Partial<Omit<DrillCode, 'id'>> = {},
): DrillCode => ({
  id,
  mnemonic: id,
  definition: `def ${id}`,
  counterExample: null,
  exemplars: [],
  facetValueIds: [],
  codebookName: 'Transcript',
  ...opts,
});

const T0 = new Date('2026-07-26T12:00:00Z');

describe('cardTypeFor', () => {
  it('classify with exemplars, recall without', () => {
    expect(cardTypeFor(code('a', { exemplars: ['x'] }))).toBe('classify');
    expect(cardTypeFor(code('b'))).toBe('recall');
  });
});

describe('pickDistractors', () => {
  const target = code('t', { facetValueIds: ['f1', 'f2'] });
  const near = code('n', { facetValueIds: ['f1', 'f2'] });
  const mid = code('m', { facetValueIds: ['f1'] });
  const far1 = code('x', { facetValueIds: ['f9'] });
  const far2 = code('y', { facetValueIds: [] });

  it('never includes the target and prefers facet-sharing near-misses', () => {
    const picked = pickDistractors(target, [target, far1, near, far2, mid], 3, 7);
    expect(picked.map((c) => c.id)).not.toContain('t');
    expect(picked[0].id).toBe('n');
    expect(picked[1].id).toBe('m');
    expect(picked).toHaveLength(3);
  });

  it('is deterministic for a given seed and varies across seeds (ties)', () => {
    const pool = [target, far1, far2, code('z'), code('w')];
    const a = pickDistractors(target, pool, 3, 1).map((c) => c.id);
    const b = pickDistractors(target, pool, 3, 1).map((c) => c.id);
    expect(a).toEqual(b);

    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      seen.add(pickDistractors(target, pool, 3, seed).map((c) => c.id).join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('returns fewer than n when the pool is small', () => {
    expect(pickDistractors(target, [target, near], 3, 0)).toHaveLength(1);
  });
});

describe('exemplarFor', () => {
  it('rotates by rep count and wraps', () => {
    const c = code('a', { exemplars: ['e0', 'e1', 'e2'] });
    expect(exemplarFor(c, 0)).toBe('e0');
    expect(exemplarFor(c, 1)).toBe('e1');
    expect(exemplarFor(c, 4)).toBe('e1');
  });
});

describe('buildQueue', () => {
  const codes = [
    code('due-old', { exemplars: ['x'] }),
    code('due-new', { exemplars: ['x'] }),
    code('later'),
    code('fresh-1', { exemplars: ['x'] }),
    code('fresh-2'),
    code('fresh-3'),
  ];
  const states = [
    { codeId: 'due-old', cardType: 'classify', due: '2026-07-20T00:00:00Z', fsrs: { s: 1 }, reps: 3 },
    { codeId: 'due-new', cardType: 'classify', due: '2026-07-26T00:00:00Z', fsrs: { s: 2 }, reps: 1 },
    { codeId: 'later', cardType: 'recall', due: '2026-08-01T00:00:00Z', fsrs: { s: 3 }, reps: 2 },
  ];

  it('includes every due card, no future card, and caps new intake', () => {
    const q = buildQueue(codes, states, T0, 2, 42);
    const ids = q.map((i) => i.code.id);
    expect(ids).toContain('due-old');
    expect(ids).toContain('due-new');
    expect(ids).not.toContain('later');
    expect(q.filter((i) => i.fsrs === null)).toHaveLength(2);
    expect(q).toHaveLength(4);
  });

  it('carries state onto due items and defaults new ones', () => {
    const q = buildQueue(codes, states, T0, 6, 42);
    const dueOld = q.find((i) => i.code.id === 'due-old')!;
    expect(dueOld.reps).toBe(3);
    expect(dueOld.fsrs).toEqual({ s: 1 });
    const fresh = q.find((i) => i.code.id === 'fresh-2')!;
    expect(fresh.reps).toBe(0);
    expect(fresh.cardType).toBe('recall');
  });

  it('is deterministic per seed', () => {
    const a = buildQueue(codes, states, T0, 3, 9).map((i) => i.code.id);
    const b = buildQueue(codes, states, T0, 3, 9).map((i) => i.code.id);
    expect(a).toEqual(b);
  });

  it('newCap 0 drills only due cards', () => {
    const q = buildQueue(codes, states, T0, 0, 1);
    expect(q.every((i) => i.fsrs !== null)).toBe(true);
  });
});

describe('rng helpers', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const va = a();
      expect(va).toBe(b());
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
    }
  });

  it('hashSeed spreads distinct ids', () => {
    expect(hashSeed('code-a')).not.toBe(hashSeed('code-b'));
  });
});

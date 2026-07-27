import { describe, it, expect } from 'vitest';
import {
  cardTypeFor,
  cardTypeIn,
  deckStats,
  pickDistractors,
  exemplarFor,
  buildQueue,
  rankCodesForQuery,
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
    const q = buildQueue('quiz', codes, states, T0, 2, 42);
    const ids = q.map((i) => i.code.id);
    expect(ids).toContain('due-old');
    expect(ids).toContain('due-new');
    expect(ids).not.toContain('later');
    expect(q.filter((i) => i.fsrs === null)).toHaveLength(2);
    expect(q).toHaveLength(4);
  });

  it('carries state onto due items and defaults new ones', () => {
    const q = buildQueue('quiz', codes, states, T0, 6, 42);
    const dueOld = q.find((i) => i.code.id === 'due-old')!;
    expect(dueOld.reps).toBe(3);
    expect(dueOld.fsrs).toEqual({ s: 1 });
    const fresh = q.find((i) => i.code.id === 'fresh-2')!;
    expect(fresh.reps).toBe(0);
    expect(fresh.cardType).toBe('recall');
  });

  it('is deterministic per seed', () => {
    const a = buildQueue('quiz', codes, states, T0, 3, 9).map((i) => i.code.id);
    const b = buildQueue('quiz', codes, states, T0, 3, 9).map((i) => i.code.id);
    expect(a).toEqual(b);
  });

  it('newCap 0 drills only due cards', () => {
    const q = buildQueue('quiz', codes, states, T0, 0, 1);
    expect(q.every((i) => i.fsrs !== null)).toBe(true);
  });

  it('ahead admits future-scheduled cards', () => {
    const q = buildQueue('quiz', codes, states, T0, 0, 1, true);
    expect(q.map((i) => i.code.id)).toContain('later');
  });

  it('name mode ignores quiz-direction states — separate schedules', () => {
    // All three states above are classify/recall, so in name mode every
    // drillable code is NEW.
    const q = buildQueue('name', codes, states, T0, 10, 5);
    expect(q.every((i) => i.fsrs === null && i.cardType === 'name')).toBe(true);
    const nameState = [
      { codeId: 'due-old', cardType: 'name', due: '2026-07-20T00:00:00Z', fsrs: { s: 9 }, reps: 1 },
    ];
    const q2 = buildQueue('name', codes, nameState, T0, 0, 5);
    expect(q2.map((i) => i.code.id)).toEqual(['due-old']);
  });
});

describe('cardTypeIn / deckStats', () => {
  it('name mode drops codes with neither definition nor exemplars', () => {
    const bare = code('bare', { definition: null });
    expect(cardTypeIn('name', bare)).toBeNull();
    expect(cardTypeIn('name', code('def'))).toBe('name');
    expect(cardTypeIn('quiz', bare)).toBe('recall');
  });

  it('deckStats partitions due / fresh / scheduled and finds next due', () => {
    const codes = [code('a'), code('b'), code('c')];
    const states = [
      { codeId: 'a', cardType: 'recall', due: '2026-07-20T00:00:00Z', fsrs: {}, reps: 1 },
      { codeId: 'b', cardType: 'recall', due: '2026-07-28T00:00:00Z', fsrs: {}, reps: 1 },
    ];
    const s = deckStats('quiz', codes, states, T0);
    expect(s).toEqual({
      due: 1,
      fresh: 1,
      scheduled: 1,
      nextDueMs: new Date('2026-07-28T00:00:00Z').getTime(),
    });
    // Same states seen from name mode: nothing drilled yet.
    expect(deckStats('name', codes, states, T0)).toEqual({
      due: 0,
      fresh: 3,
      scheduled: 0,
      nextDueMs: null,
    });
  });
});

describe('rankCodesForQuery', () => {
  const pool = [code('spec-localization'), code('spec-revision'), code('update-slot')];

  it('prefix beats substring, ties alphabetical, empty query returns all', () => {
    expect(rankCodesForQuery(pool, 'spec').map((c) => c.mnemonic)).toEqual([
      'spec-localization',
      'spec-revision',
    ]);
    expect(rankCodesForQuery(pool, 'loc').map((c) => c.mnemonic)).toEqual([
      'spec-localization',
    ]);
    expect(rankCodesForQuery(pool, '')).toHaveLength(3);
    expect(rankCodesForQuery(pool, 'zzz')).toHaveLength(0);
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

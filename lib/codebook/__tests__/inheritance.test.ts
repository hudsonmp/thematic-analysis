import { describe, expect, it } from 'vitest';
import { rollUpByValue, type ValueRow } from '@/lib/codebook/inheritance';

//  Space
//    Hypothesis          (h)
//    Experiment          (e)
//      Design            (d)
//      Execution         (x)
const VALUES: ValueRow[] = [
  { id: 'h', parent_id: null },
  { id: 'e', parent_id: null },
  { id: 'd', parent_id: 'e' },
  { id: 'x', parent_id: 'e' },
];

type C = { id: string; vals: string[] };
const ids = (c: C) => c.vals;

describe('rollUpByValue', () => {
  it('a code answering a CHILD also answers its parent — entailment, not decoration', () => {
    // Design IS-A Experiment. A code that says "Design" has said "Experiment" too.
    const roll = rollUpByValue(VALUES, [{ id: 'c1', vals: ['d'] }], ids);
    expect(roll.get('d')!.direct.map((c) => c.id)).toEqual(['c1']);
    expect(roll.get('e')!.inherited.map((c) => c.id)).toEqual(['c1']);
    expect(roll.get('e')!.direct).toEqual([]);
  });

  it('keeps DIRECT and INHERITED distinct, because they are different claims', () => {
    // c1 pinned AT Experiment said "experiment, and I decline to be finer".
    // c2 pinned at Design said something more precise. Collapsing them would destroy
    // the distinction the value chain exists to record.
    const roll = rollUpByValue(
      VALUES,
      [
        { id: 'c1', vals: ['e'] },
        { id: 'c2', vals: ['d'] },
      ],
      ids,
    );
    expect(roll.get('e')!.direct.map((c) => c.id)).toEqual(['c1']);
    expect(roll.get('e')!.inherited.map((c) => c.id)).toEqual(['c2']);
  });

  it('rolls up through MULTIPLE levels, not just one', () => {
    const deep: ValueRow[] = [
      { id: 'a', parent_id: null },
      { id: 'b', parent_id: 'a' },
      { id: 'c', parent_id: 'b' },
    ];
    const roll = rollUpByValue(deep, [{ id: 'z', vals: ['c'] }], ids);
    expect(roll.get('b')!.inherited.map((c) => c.id)).toEqual(['z']);
    expect(roll.get('a')!.inherited.map((c) => c.id)).toEqual(['z']);
  });

  it('does NOT roll DOWN — a coarse answer is not a claim about any child', () => {
    // Answering "Experiment" says nothing about Design vs Execution. Rolling down
    // would invent a precision the researcher explicitly declined to give.
    const roll = rollUpByValue(VALUES, [{ id: 'c1', vals: ['e'] }], ids);
    expect(roll.get('d')!.direct).toEqual([]);
    expect(roll.get('d')!.inherited).toEqual([]);
  });

  it('does not leak ACROSS branches', () => {
    const roll = rollUpByValue(VALUES, [{ id: 'c1', vals: ['d'] }], ids);
    expect(roll.get('h')!.direct).toEqual([]);
    expect(roll.get('h')!.inherited).toEqual([]);
    expect(roll.get('x')!.direct).toEqual([]);
  });

  it('lets DIRECT win when a legacy row answers both a parent and its child', () => {
    // The UI prevents this, but a hand-edited or older row could carry both. The
    // explicit claim is the stronger evidence of intent, so it is not ALSO listed as
    // inherited on the parent — which would double-count it in one place.
    const roll = rollUpByValue(VALUES, [{ id: 'c1', vals: ['e', 'd'] }], ids);
    expect(roll.get('e')!.direct.map((c) => c.id)).toEqual(['c1']);
    expect(roll.get('e')!.inherited).toEqual([]);
  });

  it('handles a code that CROSS-CUTS two branches of one dimension', () => {
    // The whole reason facets replaced the tree: one code, two answers, no duplicate.
    const roll = rollUpByValue(VALUES, [{ id: 'conf', vals: ['h', 'd'] }], ids);
    expect(roll.get('h')!.direct.map((c) => c.id)).toEqual(['conf']);
    expect(roll.get('d')!.direct.map((c) => c.id)).toEqual(['conf']);
    expect(roll.get('e')!.inherited.map((c) => c.id)).toEqual(['conf']);
  });

  it('ignores value ids belonging to OTHER facets, so one chain rolls up alone', () => {
    const roll = rollUpByValue(VALUES, [{ id: 'c1', vals: ['d', 'other-facet-val'] }], ids);
    expect(roll.get('d')!.direct.map((c) => c.id)).toEqual(['c1']);
  });

  it('gives every value an entry, even one no code answers', () => {
    const roll = rollUpByValue(VALUES, [], ids);
    expect([...roll.keys()].sort()).toEqual(['d', 'e', 'h', 'x']);
    expect(roll.get('e')).toEqual({ direct: [], inherited: [] });
  });

  it('cannot hang on a parent_id cycle in the data', () => {
    const cyclic: ValueRow[] = [
      { id: 'a', parent_id: 'b' },
      { id: 'b', parent_id: 'a' },
    ];
    expect(() => rollUpByValue(cyclic, [{ id: 'z', vals: ['a'] }], ids)).not.toThrow();
  });
});

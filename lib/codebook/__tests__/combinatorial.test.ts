import { describe, it, expect } from 'vitest';
import {
  resolveFork,
  validateDefinition,
  stagesOf,
  evaluateOrder,
  checkFulfillment,
  subsumption,
  serializeSnapshot,
  type ModularBucket,
  type ForkDelta,
  type CodeDef,
  type DefItem,
  type BucketMember,
} from '../combinatorial';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const m = (codeId: string, mandatory = false): BucketMember => ({ codeId, mandatory });

const bucket = (id: string, members: BucketMember[], name = id): ModularBucket => ({
  id,
  name,
  caption: null,
  members,
});

const bItem = (id: string, position: number, bucketId: string, interchangeGroup: number | null = null): DefItem =>
  ({ id, position, interchangeGroup, kind: 'bucket', bucketId }) as DefItem;

const sItem = (id: string, position: number, codeId: string, interchangeGroup: number | null = null): DefItem =>
  ({ id, position, interchangeGroup, kind: 'singleton', codeId }) as DefItem;

const def = (codeId: string, items: DefItem[]): CodeDef => ({ codeId, items });

/** Item-keyed members: the engine now reads a SLOT's effective member set,
 *  not a bucket's — per-slot forks made the bucket id alone insufficient. The
 *  plain helper resolves an item to its bucket's modular members; the fork-
 *  aware one overlays a Δ on specific item ids (slot forks). */
const itemMembers =
  (buckets: ModularBucket[]) =>
  (item: DefItem): BucketMember[] =>
    item.kind === 'bucket' ? (buckets.find((b) => b.id === item.bucketId)?.members ?? []) : [];

const withSlotForks =
  (base: (item: DefItem) => BucketMember[], forks: Record<string, ForkDelta>) =>
  (item: DefItem): BucketMember[] => {
    const delta = forks[item.id];
    if (!delta) return base(item);
    return resolveFork(
      { id: item.id, name: item.id, caption: null, members: base(item) },
      delta,
    ).members;
  };

// ---------------------------------------------------------------------------
// resolveFork — fork = modular + Δ; pull automatic for non-overridden attrs;
// deletions at modular never auto-pull (flagged, kept).
// ---------------------------------------------------------------------------

describe('resolveFork', () => {
  const mod = bucket('B1', [m('review-1'), m('review-2', true)], 'Review');

  it('null delta → effective view IS the modular view (pull is automatic)', () => {
    const eff = resolveFork(mod, null);
    expect(eff.members).toEqual(mod.members);
    expect(eff.caption).toBe(mod.caption);
    expect(eff.pendingDeletions).toEqual([]);
  });

  it('added codes appear; mandatory overrides apply; caption override sticks', () => {
    const delta: ForkDelta = {
      addedCodes: [m('my-new-code', true)],
      mandatoryOverrides: { 'review-2': false },
      caption: 'my caption',
    };
    const eff = resolveFork({ ...mod, caption: 'modular caption' }, delta);
    expect(eff.members.map((x) => x.codeId)).toContain('my-new-code');
    expect(eff.members.find((x) => x.codeId === 'review-2')!.mandatory).toBe(false);
    expect(eff.caption).toBe('my caption');
  });

  it('non-overridden caption pulls the modular value', () => {
    const eff = resolveFork({ ...mod, caption: 'modular caption' }, { addedCodes: [] });
    expect(eff.caption).toBe('modular caption');
  });

  it('fork-local removals drop the member from the effective view', () => {
    const eff = resolveFork(mod, { removedCodeIds: ['review-1'] });
    expect(eff.members.map((x) => x.codeId)).not.toContain('review-1');
  });

  it('a modular deletion NEVER auto-pulls: seen member missing at modular is kept and flagged', () => {
    const delta: ForkDelta = { seen: [m('review-1'), m('review-2', true), m('gone-code')] };
    const eff = resolveFork(mod, delta);
    expect(eff.members.map((x) => x.codeId)).toContain('gone-code'); // kept until resolved
    expect(eff.pendingDeletions.map((x) => x.codeId)).toEqual(['gone-code']);
  });

  it('a modular deletion the fork itself also removed is NOT flagged', () => {
    const delta: ForkDelta = { seen: [m('gone-code')], removedCodeIds: ['gone-code'] };
    const eff = resolveFork(mod, delta);
    expect(eff.pendingDeletions).toEqual([]);
    expect(eff.members.map((x) => x.codeId)).not.toContain('gone-code');
  });
});

// ---------------------------------------------------------------------------
// validateDefinition — DAG guard, empty-bucket guard, interchange contiguity.
// ---------------------------------------------------------------------------

describe('validateDefinition', () => {
  const B1 = bucket('B1', [m('p1'), m('p2')]);
  const B2 = bucket('B2', [m('p3')]);
  const EMPTY = bucket('BE', []);
  const buckets = [B1, B2, EMPTY];

  it('accepts a well-formed two-bucket definition', () => {
    const d = def('parent', [bItem('i1', 1, 'B1'), bItem('i2', 2, 'B2')]);
    expect(validateDefinition(d, new Map([['parent', d]]), itemMembers(buckets))).toEqual([]);
  });

  it('rejects an empty bucket reference', () => {
    const d = def('parent', [bItem('i1', 1, 'BE')]);
    const errs = validateDefinition(d, new Map([['parent', d]]), itemMembers(buckets));
    expect(errs.some((e) => /empty bucket/i.test(e))).toBe(true);
  });

  it('rejects a direct cycle: code whose bucket contains itself', () => {
    const SELF = bucket('BS', [m('parent')]);
    const d = def('parent', [bItem('i1', 1, 'BS')]);
    const errs = validateDefinition(d, new Map([['parent', d]]), itemMembers([SELF]));
    expect(errs.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it('rejects an indirect cycle through a combinatorial member (grandchild loop)', () => {
    // parent → B(child) ; child → B2(grandchild) ; grandchild → B3(parent)  ⇒ cycle
    const BA = bucket('BA', [m('child')]);
    const BB = bucket('BB', [m('grandchild')]);
    const BC = bucket('BC', [m('parent')]);
    const dParent = def('parent', [bItem('i1', 1, 'BA')]);
    const dChild = def('child', [bItem('i2', 1, 'BB')]);
    const dGrand = def('grandchild', [bItem('i3', 1, 'BC')]);
    const defs = new Map([
      ['parent', dParent],
      ['child', dChild],
      ['grandchild', dGrand],
    ]);
    const errs = validateDefinition(dParent, defs, itemMembers([BA, BB, BC]));
    expect(errs.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it('rejects a singleton cycle', () => {
    const dA = def('A', [sItem('i1', 1, 'B')]);
    const dB = def('B', [sItem('i2', 1, 'A')]);
    const errs = validateDefinition(dA, new Map([['A', dA], ['B', dB]]), itemMembers([]));
    expect(errs.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it('accepts a legal DAG (diamond: two items sharing a primitive)', () => {
    const BX = bucket('BX', [m('leaf')]);
    const BY = bucket('BY', [m('leaf')]);
    const d = def('parent', [bItem('i1', 1, 'BX'), bItem('i2', 2, 'BY')]);
    expect(validateDefinition(d, new Map([['parent', d]]), itemMembers([BX, BY]))).toEqual([]);
  });

  it('rejects a NON-contiguous interchange group', () => {
    const d = def('parent', [
      bItem('i1', 1, 'B1', 7),
      bItem('i2', 2, 'B2', null),
      bItem('i3', 3, 'B1', 7), // group 7 split by position 2 → illegal
    ]);
    const errs = validateDefinition(d, new Map([['parent', d]]), itemMembers(buckets));
    expect(errs.some((e) => /contiguous/i.test(e))).toBe(true);
  });

  it('rejects duplicate positions', () => {
    const d = def('parent', [bItem('i1', 1, 'B1'), bItem('i2', 1, 'B2')]);
    const errs = validateDefinition(d, new Map([['parent', d]]), itemMembers(buckets));
    expect(errs.some((e) => /position/i.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stagesOf + evaluateOrder — series-parallel first-evidence ordering.
// ---------------------------------------------------------------------------

describe('order evaluation', () => {
  // {1,2} interchangeable ≺ 3 ≺ 4
  const items = [
    bItem('a', 1, 'B1', 1),
    bItem('b', 2, 'B2', 1),
    bItem('c', 3, 'B1'),
    bItem('d', 4, 'B2'),
  ];

  it('stagesOf collapses an interchange group into one stage', () => {
    const stages = stagesOf(items);
    expect(stages.map((s) => s.itemIds)).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('in-order evidence → no violation (ties permitted)', () => {
    const ev = new Map([
      ['a', 5],
      ['b', 3],
      ['c', 5], // tie with a — permitted
      ['d', 9],
    ]);
    expect(evaluateOrder(items, ev).violated).toBe(false);
  });

  it('out-of-order across stages → violated, with the conflicting pair named', () => {
    const ev = new Map([
      ['a', 2],
      ['b', 3],
      ['c', 10],
      ['d', 4], // d (stage 3) earlier than c (stage 2) → violation
    ]);
    const r = evaluateOrder(items, ev);
    expect(r.violated).toBe(true);
    expect(r.conflicts.some((x) => x.earlierItemId === 'c' && x.laterItemId === 'd')).toBe(true);
  });

  it('order INSIDE an interchange group is unconstrained', () => {
    const ev = new Map([
      ['a', 9],
      ['b', 1], // b before a — same group, fine
      ['c', 9],
      ['d', 9],
    ]);
    expect(evaluateOrder(items, ev).violated).toBe(false);
  });

  it('missing evidence (attested / partial decomposition) is skipped, never violates', () => {
    const ev = new Map([['c', 4]]); // only one item evidenced
    expect(evaluateOrder(items, ev).violated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkFulfillment — AND across items, ≥1 admissible member per bucket item,
// mandatory members surfaced, first-evidence extraction.
// ---------------------------------------------------------------------------

describe('checkFulfillment', () => {
  const B1 = bucket('B1', [m('scenario-a'), m('scenario-b')]);
  const B2 = bucket('B2', [m('edit-a'), m('edit-b', true)]); // edit-b mandatory
  const buckets = [B1, B2];
  const parent = def('experiment-driven-change', [
    bItem('i1', 1, 'B1'),
    bItem('i2', 2, 'B2'),
    sItem('i3', 3, 'must-have'),
  ]);

  it('complete when every bucket item has ≥1 admissible child and singletons matched', () => {
    const r = checkFulfillment(
      parent,
      [
        { itemId: 'i1', childCodeId: 'scenario-a', sentences: [3] },
        { itemId: 'i2', childCodeId: 'edit-a', sentences: [7] },
        { itemId: 'i2', childCodeId: 'edit-b', sentences: [8] },
        { itemId: 'i3', childCodeId: 'must-have', sentences: [9] },
      ],
      itemMembers(buckets),
    );
    expect(r.complete).toBe(true);
    expect(r.missingItemIds).toEqual([]);
    expect(r.mandatoryMissing).toEqual([]);
  });

  it('multiple children may fulfill one bucket; one is required', () => {
    const r = checkFulfillment(
      parent,
      [
        { itemId: 'i1', childCodeId: 'scenario-a', sentences: [1] },
        { itemId: 'i1', childCodeId: 'scenario-b', sentences: [2] },
      ],
      itemMembers(buckets),
    );
    expect(r.missingItemIds.sort()).toEqual(['i2', 'i3']);
    expect(r.complete).toBe(false);
  });

  it('an inadmissible child does NOT fulfill the bucket', () => {
    const r = checkFulfillment(
      parent,
      [{ itemId: 'i1', childCodeId: 'edit-a', sentences: [1] }], // edit-a ∉ B1
      itemMembers(buckets),
    );
    expect(r.missingItemIds).toContain('i1');
  });

  it('a fulfilled bucket with an unassigned MANDATORY member surfaces it (warn, not block)', () => {
    const r = checkFulfillment(
      parent,
      [
        { itemId: 'i1', childCodeId: 'scenario-a', sentences: [1] },
        { itemId: 'i2', childCodeId: 'edit-a', sentences: [2] }, // edit-b (mandatory) missing
        { itemId: 'i3', childCodeId: 'must-have', sentences: [3] },
      ],
      itemMembers(buckets),
    );
    expect(r.complete).toBe(true); // fulfillment ≠ mandatory satisfaction; warn-level
    expect(r.mandatoryMissing).toEqual([{ itemId: 'i2', codeIds: ['edit-b'] }]);
  });

  it('a SUBSUMPTION link (via set) fulfills a bucket item even though the subsuming code is not a member', () => {
    const r = checkFulfillment(
      parent,
      [
        // c1 subsumes B1's slot: childCodeId is the combinatorial c1, NOT a member.
        { itemId: 'i1', childCodeId: 'c1', sentences: [2], via: 'c1' },
        { itemId: 'i2', childCodeId: 'edit-a', sentences: [5] },
        { itemId: 'i3', childCodeId: 'must-have', sentences: [6] },
      ],
      itemMembers(buckets),
    );
    expect(r.missingItemIds).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.firstEvidence.get('i1')).toBe(2);
  });

  it('a via link does NOT satisfy a singleton item (exact code required)', () => {
    const r = checkFulfillment(
      parent,
      [{ itemId: 'i3', childCodeId: 'c1', sentences: [1], via: 'c1' }],
      itemMembers(buckets),
    );
    expect(r.missingItemIds).toContain('i3');
  });

  it('first evidence per item = min sentence across its links (double-serving allowed)', () => {
    const r = checkFulfillment(
      parent,
      [
        { itemId: 'i1', childCodeId: 'scenario-a', sentences: [9, 4] },
        { itemId: 'i2', childCodeId: 'edit-a', sentences: [4] }, // sentence 4 double-serves
      ],
      itemMembers(buckets),
    );
    expect(r.firstEvidence.get('i1')).toBe(4);
    expect(r.firstEvidence.get('i2')).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// subsumption — c₁ substitutes for a subset S of parent's buckets iff per-bucket
// admissible(c₁) ⊆ admissible(parent); targets must be one interchange group.
// Sub's members are read under the CODER'S fork; parent's under MODULAR — so a
// fork with unpushed added codes cannot substitute into standard slots.
// ---------------------------------------------------------------------------

describe('subsumption', () => {
  const REVIEW = bucket('R', [m('rev-1'), m('rev-2')]);
  const REVIEW_WIDE = bucket('RW', [m('rev-1'), m('rev-2'), m('rev-3')]);
  const EDIT = bucket('E', [m('ed-1')]);

  it('sub whose single bucket is a subset of one parent bucket → mapping found', () => {
    const sub = def('c1', [bItem('s1', 1, 'R')]);
    const parent = def('c2', [bItem('p1', 1, 'RW'), bItem('p2', 2, 'E')]);
    const r = subsumption(sub, parent, itemMembers([REVIEW, REVIEW_WIDE, EDIT]), itemMembers([REVIEW, REVIEW_WIDE, EDIT]));
    expect(r).toEqual([{ parentItemId: 'p1', viaSubItemId: 's1' }]);
  });

  it('no mapping when sub admits a code the parent bucket does not', () => {
    const sub = def('c1', [bItem('s1', 1, 'RW')]); // wider than parent's R
    const parent = def('c2', [bItem('p1', 1, 'R')]);
    const r = subsumption(sub, parent, itemMembers([REVIEW, REVIEW_WIDE]), itemMembers([REVIEW, REVIEW_WIDE]));
    expect(r).toBeNull();
  });

  it('slot-fork-added unpushed code blocks substitution (sub slot view ⊄ parent slot view)', () => {
    const base = itemMembers([REVIEW, REVIEW_WIDE, EDIT]);
    const sub = def('c1', [bItem('s1', 1, 'R')]);
    const parent = def('c2', [bItem('p1', 1, 'R')]);
    // Sub's R slot is forked (+my-fork-code, unpushed); parent's R slot is not.
    const subView = withSlotForks(base, { s1: { addedCodes: [m('my-fork-code')] } });
    expect(subsumption(sub, parent, subView, base)).toBeNull();
  });

  it('multi-bucket sub must land inside ONE interchange group of the parent', () => {
    const A = bucket('A', [m('a1')]);
    const B = bucket('B', [m('b1')]);
    const AW = bucket('AW', [m('a1'), m('x')]);
    const BW = bucket('BW', [m('b1'), m('y')]);
    const sub = def('c1', [bItem('s1', 1, 'A'), bItem('s2', 2, 'B')]);
    const mAll = itemMembers([A, B, AW, BW]);
    // parent items 1,2 in one interchange group → OK
    const pGood = def('c2', [bItem('p1', 1, 'AW', 1), bItem('p2', 2, 'BW', 1), bItem('p3', 3, 'A')]);
    expect(subsumption(sub, pGood, mAll, mAll)).not.toBeNull();
    // parent items NOT in a shared group → blocked
    const pBad = def('c2', [bItem('p1', 1, 'AW'), bItem('p2', 2, 'BW')]);
    expect(subsumption(sub, pBad, mAll, mAll)).toBeNull();
  });

  it('a single-item substitution needs no interchange group (singleton target is trivially a group)', () => {
    const sub = def('c1', [bItem('s1', 1, 'R')]);
    const parent = def('c2', [bItem('p1', 1, 'R'), bItem('p2', 2, 'E')]);
    const mAll = itemMembers([REVIEW, EDIT]);
    expect(subsumption(sub, parent, mAll, mAll)).toEqual([{ parentItemId: 'p1', viaSubItemId: 's1' }]);
  });

  // Hudson's hand-drawn example, end to end at the engine level.
  describe("Hudson's example: experimental-identification ⊑ structure-driven-hypothesis", () => {
    const REVIEW_B = bucket('REV', [m('experimental-identification'), m('behavior-reconciliation')], 'Review');
    const STRUCTURE = bucket('STR', [m('new-components'), m('structure-reconciliation')], 'Structure');
    const base = itemMembers([REVIEW_B, STRUCTURE]);

    // experimental-identification: Review{behavior-reconciliation} + Structure
    // with a SLOT FORK appending queue-added-to-structure (mandatory).
    const sub = def('experimental-identification', [
      bItem('ei-rev', 1, 'REV'),
      bItem('ei-str', 2, 'STR'),
    ]);
    const subForks = {
      'ei-rev': { removedCodeIds: ['experimental-identification'] },
      'ei-str': { addedCodes: [m('queue-added-to-structure', true)] },
    } as Record<string, ForkDelta>;
    const subView = withSlotForks(base, subForks);

    // structure-driven-hypothesis: {Review, Structure} interchangeable ≺ Issue ≺ Change.
    const ISSUE = bucket('ISS', [m('issue-found')], 'Issue');
    const CHANGE = bucket('CHG', [m('change-made')], 'Change');
    const parent = def('structure-driven-hypothesis', [
      bItem('p-rev', 1, 'REV', 1),
      bItem('p-str', 2, 'STR', 1),
      bItem('p-iss', 3, 'ISS'),
      bItem('p-chg', 4, 'CHG'),
    ]);

    it('slot fork resolves: Structure slot gains queue-added-to-structure AS MANDATORY, modular untouched', () => {
      const eff = subView(sub.items[1]);
      expect(eff.find((x) => x.codeId === 'queue-added-to-structure')).toEqual(
        m('queue-added-to-structure', true),
      );
      // the modular Structure bucket itself is untouched (pure overlay)
      expect(base(sub.items[1]).some((x) => x.codeId === 'queue-added-to-structure')).toBe(false);
    });

    it('mandatory is enforced from the SLOT view: fulfilling the forked Structure slot without the appended code surfaces it', () => {
      const r = checkFulfillment(
        sub,
        [
          { itemId: 'ei-rev', childCodeId: 'behavior-reconciliation', sentences: [1] },
          { itemId: 'ei-str', childCodeId: 'new-components', sentences: [2] },
        ],
        subView,
      );
      expect(r.complete).toBe(true); // warn, never block
      expect(r.mandatoryMissing).toEqual([
        { itemId: 'ei-str', codeIds: ['queue-added-to-structure'] },
      ]);
    });

    it('UNPUSHED slot fork blocks substitution into the parent (push-first rule)', () => {
      const parentView = itemMembers([REVIEW_B, STRUCTURE, ISSUE, CHANGE]);
      expect(subsumption(sub, parent, subView, parentView)).toBeNull();
    });

    it('after push (modular Structure gains the code NON-mandatory) the sub substitutes into the {Review, Structure} interchange group', () => {
      const STRUCTURE_PUSHED = bucket(
        'STR',
        [...STRUCTURE.members, m('queue-added-to-structure', false)],
        'Structure',
      );
      const pushedBase = itemMembers([REVIEW_B, STRUCTURE_PUSHED, ISSUE, CHANGE]);
      // Sub still carries its fork: the mandatory flag stays FORK-LOCAL, but the
      // member SET now matches modular, so ⊆ holds per slot.
      const subViewPushed = withSlotForks(pushedBase, subForks);
      const mapping = subsumption(sub, parent, subViewPushed, pushedBase);
      expect(mapping).not.toBeNull();
      expect(new Set(mapping!.map((x) => x.parentItemId))).toEqual(new Set(['p-rev', 'p-str']));
    });
  });
});

// ---------------------------------------------------------------------------
// serializeSnapshot — deterministic: same state in any key order → same string.
// ---------------------------------------------------------------------------

describe('serializeSnapshot', () => {
  it('is key-order independent and stable', () => {
    const a = serializeSnapshot({ codes: [{ id: 'z' }, { id: 'a' }], buckets: [{ id: 'b', name: 'B' }] });
    const b = serializeSnapshot({ buckets: [{ id: 'b', name: 'B' }], codes: [{ id: 'a' }, { id: 'z' }] });
    expect(a).toBe(b);
  });

  it('different state → different string', () => {
    const a = serializeSnapshot({ codes: [{ id: 'a' }] });
    const b = serializeSnapshot({ codes: [{ id: 'a', extra: 1 }] });
    expect(a).not.toBe(b);
  });
});

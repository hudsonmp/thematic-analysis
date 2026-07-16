import { describe, expect, it } from 'vitest';
import {
  assignToGroup,
  groupFromPair,
  groupOf,
  looseCodes,
  pruneGroups,
  removeFromGroups,
  unfiledCodes,
  type StagedGroup,
} from '@/lib/codebook/staging';

/**
 * Two facets in play throughout. SPACE is the dimension being staged; its value tree is
 * v1 → (v1a, v1b), plus a sibling v2. LOCUS is a DIFFERENT dimension entirely (w1).
 * `facetValueIds` handed to unfiledCodes is always the id set of ONE dimension.
 */
const SPACE = new Set(['v1', 'v1a', 'v1b', 'v2']);

const g = (id: string, name: string, codeIds: string[]): StagedGroup => ({ id, name, codeIds });

describe('unfiledCodes — unfiled is relative to ONE facet', () => {
  it('counts a code answering a NESTED value of the dimension as FILED', () => {
    // A child value is still a value of the dimension. Demanding the code also answer
    // the parent would be asking it to restate, less precisely, a claim it already made
    // — and would strand every deeply-placed code back in the loose pile forever.
    const codes = [{ id: 'c1', facetValueIds: ['v1a'] }];
    expect(unfiledCodes(codes, SPACE)).toEqual([]);
  });

  it('still counts a code filed on ANOTHER facet as unfiled HERE', () => {
    // Being placed on Locus says nothing about whether the code answers Space. If
    // cross-facet placement suppressed a code from the staging box, the researcher would
    // silently never be asked the Space question about it.
    const codes = [{ id: 'c1', facetValueIds: ['w1'] }];
    expect(unfiledCodes(codes, SPACE).map((c) => c.id)).toEqual(['c1']);
  });

  it('counts a code with NO placements at all as unfiled', () => {
    const codes = [{ id: 'c1', facetValueIds: [] }];
    expect(unfiledCodes(codes, SPACE).map((c) => c.id)).toEqual(['c1']);
  });

  it('files a code that answers this dimension among answers to others', () => {
    // Multi-facet codes are the normal case, not the exception: one hit inside the
    // dimension is enough to file it, however much other-facet noise surrounds it.
    const codes = [{ id: 'c1', facetValueIds: ['w1', 'v2', 'w2'] }];
    expect(unfiledCodes(codes, SPACE)).toEqual([]);
  });

  it('partitions a mixed pile, preserving input order', () => {
    // Order stability matters because this list renders directly: a filter that
    // reshuffled would move codes under the researcher's cursor mid-drag.
    const codes = [
      { id: 'c1', facetValueIds: ['v1'] }, // filed (top-level value)
      { id: 'c2', facetValueIds: [] }, // unfiled (nothing)
      { id: 'c3', facetValueIds: ['v1b'] }, // filed (nested value)
      { id: 'c4', facetValueIds: ['w1'] }, // unfiled (other facet only)
    ];
    expect(unfiledCodes(codes, SPACE).map((c) => c.id)).toEqual(['c2', 'c4']);
  });

  it('treats an EMPTY dimension as filing nothing', () => {
    // A facet with no values yet (freshly created) must show its whole corpus as unfiled
    // — that is precisely the state axial coding starts from.
    const codes = [{ id: 'c1', facetValueIds: ['v1'] }];
    expect(unfiledCodes(codes, new Set<string>()).map((c) => c.id)).toEqual(['c1']);
  });

  it('does not mutate the codes array it is given', () => {
    // These functions feed React state; an in-place filter would leave the previous
    // render's snapshot silently rewritten and defeat identity-based change detection.
    const codes = [
      { id: 'c1', facetValueIds: ['v1'] },
      { id: 'c2', facetValueIds: [] },
    ];
    const before = structuredClone(codes);
    unfiledCodes(codes, SPACE);
    expect(codes).toEqual(before);
  });
});

describe('assignToGroup — a code lives in at most one group', () => {
  it('removes the code from every OTHER group as it lands in the target', () => {
    // A group is an un-named facet value. A code sitting in two un-named clusters makes
    // both unreadable — you can no longer see what either cluster IS. Cross-cutting is a
    // claim you make after the values exist and are named, not one smuggled through
    // staging.
    const groups = [g('g1', '', ['c1', 'c2']), g('g2', '', ['c3'])];
    const next = assignToGroup(groups, 'c1', 'g2');
    expect(next.find((x) => x.id === 'g1')!.codeIds).toEqual(['c2']);
    expect(next.find((x) => x.id === 'g2')!.codeIds).toEqual(['c3', 'c1']);
  });

  it('is idempotent — re-adding a code to its current group does not duplicate the id', () => {
    // A drop that lands where the code already is (a jittery drag, a re-drop) is a no-op,
    // not a way to get the same code twice in one cluster and double its apparent weight.
    const groups = [g('g1', '', ['c1', 'c2'])];
    const next = assignToGroup(groups, 'c1', 'g1');
    expect(next[0].codeIds).toEqual(['c1', 'c2']);
  });

  it('appends a loose code to the target group, leaving other groups untouched', () => {
    const groups = [g('g1', 'Named', ['c1']), g('g2', '', [])];
    const next = assignToGroup(groups, 'c9', 'g2');
    expect(next.find((x) => x.id === 'g1')!.codeIds).toEqual(['c1']);
    expect(next.find((x) => x.id === 'g2')!.codeIds).toEqual(['c9']);
  });

  it('leaves the emptied source group in place rather than deleting it', () => {
    // Moving the last code out of a cluster does not mean the cluster was wrong — pruning
    // is a separate, explicit step (see pruneGroups), so a named category survives a
    // reshuffle of its members.
    const groups = [g('g1', 'Impasse', ['c1']), g('g2', '', [])];
    const next = assignToGroup(groups, 'c1', 'g2');
    expect(next.map((x) => x.id)).toEqual(['g1', 'g2']);
    expect(next.find((x) => x.id === 'g1')!.codeIds).toEqual([]);
  });

  it('preserves group names and ordering', () => {
    // The box must not reorder under a drop: groups are positioned on a canvas the
    // researcher is navigating spatially.
    const groups = [g('g1', 'Alpha', ['c1']), g('g2', 'Beta', ['c2'])];
    const next = assignToGroup(groups, 'c1', 'g2');
    expect(next.map((x) => ({ id: x.id, name: x.name }))).toEqual([
      { id: 'g1', name: 'Alpha' },
      { id: 'g2', name: 'Beta' },
    ]);
  });

  it('is a NO-OP when the target group id does not exist — never a silent eviction', () => {
    // The naive "remove from every other group, then add to the target" degenerates when
    // the target is absent: the removal still runs, the add cannot, and the code lands
    // loose. That is destructive, and staged groups live in localStorage — SHARED across
    // tabs — so a group promoted in one tab leaves a stale drop target in another, where
    // a drop would then silently UNFILE the code rather than doing nothing. Guarded.
    const groups = [g('g1', '', ['c1'])];
    const next = assignToGroup(groups, 'c1', 'nope');
    expect(next).toEqual(groups);
    expect(groupOf(next, 'c1')?.id).toBe('g1');
  });

  it('does not mutate the groups it is given', () => {
    const groups = [g('g1', '', ['c1', 'c2']), g('g2', '', ['c3'])];
    const before = structuredClone(groups);
    const next = assignToGroup(groups, 'c1', 'g2');
    expect(groups).toEqual(before);
    expect(next).not.toBe(groups);
    expect(next[0]).not.toBe(groups[0]);
  });
});

describe('removeFromGroups — back to the loose pile', () => {
  it('pulls the code out of whichever group holds it', () => {
    const groups = [g('g1', '', ['c1', 'c2']), g('g2', '', ['c3'])];
    const next = removeFromGroups(groups, 'c2');
    expect(next.find((x) => x.id === 'g1')!.codeIds).toEqual(['c1']);
    expect(next.find((x) => x.id === 'g2')!.codeIds).toEqual(['c3']);
  });

  it('leaves an EMPTIED group in place rather than deleting it', () => {
    // An empty group is a category you have decided is real but have not yet populated —
    // a legitimate mid-sort state. Auto-deleting it on the removal of its last member
    // would destroy the researcher's in-progress thought as a side effect of a drag.
    const groups = [g('g1', '', ['c1'])];
    const next = removeFromGroups(groups, 'c1');
    expect(next).toEqual([g('g1', '', [])]);
  });

  it('is a harmless no-op for a code that is in no group', () => {
    const groups = [g('g1', '', ['c1'])];
    expect(removeFromGroups(groups, 'c9')).toEqual(groups);
  });

  it('does not mutate the groups it is given', () => {
    const groups = [g('g1', '', ['c1', 'c2'])];
    const before = structuredClone(groups);
    const next = removeFromGroups(groups, 'c1');
    expect(groups).toEqual(before);
    expect(next[0]).not.toBe(groups[0]);
  });
});

describe('groupFromPair — the drop of one code onto another', () => {
  it('creates a new, UN-NAMED group holding both codes', () => {
    // Un-named is the point: dragging two codes together asserts only "these belong to
    // one thing". Naming it is the separate act of promotion, and forcing it here would
    // demand the answer before the researcher has seen the cluster.
    const next = groupFromPair([], 'g1', 'c1', 'c2');
    expect(next).toEqual([g('g1', '', ['c1', 'c2'])]);
  });

  it('pulls BOTH codes out of any prior groups', () => {
    // Otherwise the new cluster is a lie: each code would still be counted in its old
    // group too, and the at-most-one-group invariant that makes a group promotable into a
    // single facet value would be broken at birth.
    const groups = [g('g1', '', ['c1', 'cx']), g('g2', '', ['c2', 'cy'])];
    const next = groupFromPair(groups, 'g3', 'c1', 'c2');
    expect(next.find((x) => x.id === 'g1')!.codeIds).toEqual(['cx']);
    expect(next.find((x) => x.id === 'g2')!.codeIds).toEqual(['cy']);
    expect(next.find((x) => x.id === 'g3')!.codeIds).toEqual(['c1', 'c2']);
  });

  it('pulls both codes out even when they shared ONE prior group', () => {
    // Regrouping an existing pair into a fresh cluster must not leave them double-counted
    // in the group they came from.
    const groups = [g('g1', '', ['c1', 'c2', 'c3'])];
    const next = groupFromPair(groups, 'g2', 'c1', 'c2');
    expect(next.find((x) => x.id === 'g1')!.codeIds).toEqual(['c3']);
    expect(next.find((x) => x.id === 'g2')!.codeIds).toEqual(['c1', 'c2']);
  });

  it('handles a === b (a code dropped on ITSELF) without duplicating the member', () => {
    // The UI cannot fully prevent this drop, and a group holding ['c1','c1'] would render
    // the same code twice and inflate the cluster's apparent support. One code, one seat.
    const next = groupFromPair([], 'g1', 'c1', 'c1');
    expect(next).toEqual([g('g1', '', ['c1'])]);
  });

  it('handles a === b for a code that was already grouped', () => {
    // It leaves its old group and re-seeds a singleton — still exactly one membership.
    const groups = [g('g1', '', ['c1', 'c2'])];
    const next = groupFromPair(groups, 'g2', 'c1', 'c1');
    expect(next.find((x) => x.id === 'g1')!.codeIds).toEqual(['c2']);
    expect(next.find((x) => x.id === 'g2')!.codeIds).toEqual(['c1']);
  });

  it('takes the new id as an argument rather than generating one', () => {
    // A module that called crypto.randomUUID() would no longer be pure and could not be
    // replayed in a test — the id is the caller's business, and here it is exactly ours.
    const next = groupFromPair([], 'chosen-id', 'c1', 'c2');
    expect(next.at(-1)!.id).toBe('chosen-id');
  });

  it('appends the new group after existing ones, preserving their order', () => {
    const groups = [g('g1', 'Alpha', ['cx']), g('g2', 'Beta', ['cy'])];
    const next = groupFromPair(groups, 'g3', 'c1', 'c2');
    expect(next.map((x) => x.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('does not mutate the groups it is given', () => {
    const groups = [g('g1', '', ['c1'])];
    const before = structuredClone(groups);
    const next = groupFromPair(groups, 'g2', 'c1', 'c2');
    expect(groups).toEqual(before);
    expect(next).toHaveLength(2);
  });
});

describe('pruneGroups — dropping the husks, keeping the intentions', () => {
  it('KEEPS an empty but NAMED group', () => {
    // "I know this category is real, I just have not populated it yet" is a legitimate
    // mid-sort state — the name IS the researcher's committed thought. Pruning it because
    // it happens to be empty would delete the idea and leave only the bookkeeping.
    const groups = [g('g1', 'Impasse', [])];
    expect(pruneGroups(groups)).toEqual(groups);
  });

  it('DROPS an empty un-named group', () => {
    // A cluster with no members and no name carries zero information: it is a husk left
    // over from a promote or a drag-out, and letting them accumulate is exactly the rot
    // that keeping groups provisional was supposed to prevent.
    expect(pruneGroups([g('g1', '', [])])).toEqual([]);
  });

  it('treats a whitespace-only name as un-named', () => {
    // A stray space typed into the name field is not a decision — trimming keeps the
    // "have you actually named this?" test honest.
    expect(pruneGroups([g('g1', '   ', [])])).toEqual([]);
  });

  it('KEEPS a populated un-named group', () => {
    // Members are the whole point of a provisional cluster; it is un-named precisely
    // because the researcher has not yet answered "what IS this?".
    const groups = [g('g1', '', ['c1'])];
    expect(pruneGroups(groups)).toEqual(groups);
  });

  it('prunes selectively across a mixed box, preserving order', () => {
    const groups = [
      g('g1', '', ['c1']), // populated, un-named → keep
      g('g2', '', []), // husk → drop
      g('g3', 'Repair', []), // named intention → keep
      g('g4', 'Impasse', ['c2']), // both → keep
      g('g5', '\t\n', []), // whitespace name, empty → drop
    ];
    expect(pruneGroups(groups).map((x) => x.id)).toEqual(['g1', 'g3', 'g4']);
  });

  it('does not mutate the groups it is given', () => {
    const groups = [g('g1', '', ['c1']), g('g2', '', [])];
    const before = structuredClone(groups);
    const next = pruneGroups(groups);
    expect(groups).toEqual(before);
    expect(next).not.toBe(groups);
    expect(groups).toHaveLength(2);
  });
});

describe('groupOf — where does this code currently sit', () => {
  it('returns the group holding the code', () => {
    const groups = [g('g1', '', ['c1']), g('g2', 'Repair', ['c2', 'c3'])];
    expect(groupOf(groups, 'c3')).toEqual(g('g2', 'Repair', ['c2', 'c3']));
  });

  it('returns null for a loose code rather than undefined', () => {
    // The loose pile is a real state, not an absence — callers branch on it, so it gets an
    // explicit null instead of the undefined that a bare .find() would hand back.
    expect(groupOf([g('g1', '', ['c1'])], 'c9')).toBeNull();
  });

  it('returns null when there are no groups at all', () => {
    expect(groupOf([], 'c1')).toBeNull();
  });

  it('does not mutate the groups it is given', () => {
    const groups = [g('g1', '', ['c1'])];
    const before = structuredClone(groups);
    groupOf(groups, 'c1');
    expect(groups).toEqual(before);
  });
});

describe('looseCodes — the pile still awaiting a decision', () => {
  it('excludes anything sitting in ANY group', () => {
    // The loose pile is the researcher's remaining work. A code that is already clustered
    // showing up there too would double-render it and make the pile never look finished.
    const unfiled = [
      { id: 'c1', facetValueIds: [] },
      { id: 'c2', facetValueIds: [] },
      { id: 'c3', facetValueIds: [] },
    ];
    const groups = [g('g1', '', ['c1']), g('g2', '', ['c3'])];
    expect(looseCodes(unfiled, groups).map((c) => c.id)).toEqual(['c2']);
  });

  it('returns everything when there are no groups', () => {
    const unfiled = [
      { id: 'c1', facetValueIds: [] },
      { id: 'c2', facetValueIds: [] },
    ];
    expect(looseCodes(unfiled, []).map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('is unaffected by an empty group', () => {
    // An empty named group holds nobody, so it removes nobody from the pile — pruning and
    // loose-listing are orthogonal.
    const unfiled = [{ id: 'c1', facetValueIds: [] }];
    expect(looseCodes(unfiled, [g('g1', 'Impasse', [])]).map((c) => c.id)).toEqual(['c1']);
  });

  it('ignores group members that are not in the unfiled pile', () => {
    // A group can hold a code that has since been filed on this facet elsewhere; that
    // stale membership must not corrupt the loose list.
    const unfiled = [{ id: 'c2', facetValueIds: [] }];
    expect(looseCodes(unfiled, [g('g1', '', ['c1'])]).map((c) => c.id)).toEqual(['c2']);
  });

  it('preserves the order of the unfiled pile', () => {
    const unfiled = [
      { id: 'c3', facetValueIds: [] },
      { id: 'c1', facetValueIds: [] },
      { id: 'c2', facetValueIds: [] },
    ];
    expect(looseCodes(unfiled, []).map((c) => c.id)).toEqual(['c3', 'c1', 'c2']);
  });

  it('does not mutate the inputs it is given', () => {
    const unfiled = [
      { id: 'c1', facetValueIds: [] },
      { id: 'c2', facetValueIds: [] },
    ];
    const groups = [g('g1', '', ['c1'])];
    const beforeCodes = structuredClone(unfiled);
    const beforeGroups = structuredClone(groups);
    looseCodes(unfiled, groups);
    expect(unfiled).toEqual(beforeCodes);
    expect(groups).toEqual(beforeGroups);
  });
});

describe('composition — a full sort round-trips through the box', () => {
  it('unfiled → paired → reassigned → pruned lands in one coherent state', () => {
    // The real workflow crosses all seven functions. Each is pure, so the sequence is
    // just function composition — and the invariant (one code, one group) has to survive
    // the whole chain, not just each hop.
    const codes = [
      { id: 'c1', facetValueIds: [] },
      { id: 'c2', facetValueIds: ['w1'] }, // filed on ANOTHER facet → still unfiled here
      { id: 'c3', facetValueIds: ['v1a'] }, // filed on a NESTED value → filed, drops out
      { id: 'c4', facetValueIds: [] },
    ];

    const unfiled = unfiledCodes(codes, SPACE);
    expect(unfiled.map((c) => c.id)).toEqual(['c1', 'c2', 'c4']);

    // Drop c1 onto c2 → a new un-named cluster.
    let groups = groupFromPair([], 'g1', 'c1', 'c2');
    // Seed a second cluster from c4 dropped on itself, then name it.
    groups = groupFromPair(groups, 'g2', 'c4', 'c4');
    groups = groups.map((x) => (x.id === 'g2' ? { ...x, name: 'Repair' } : x));

    // Move c2 across: it must leave g1 in the same beat it joins g2.
    groups = assignToGroup(groups, 'c2', 'g2');
    expect(groupOf(groups, 'c2')!.id).toBe('g2');
    expect(groups.find((x) => x.id === 'g1')!.codeIds).toEqual(['c1']);

    // Pull c1 back to the pile — g1 empties but survives until pruned.
    groups = removeFromGroups(groups, 'c1');
    expect(groups.map((x) => x.id)).toEqual(['g1', 'g2']);
    expect(groupOf(groups, 'c1')).toBeNull();
    expect(looseCodes(unfiled, groups).map((c) => c.id)).toEqual(['c1']);

    // Prune: g1 (empty, un-named) is a husk; g2 (named, populated) is the real category.
    groups = pruneGroups(groups);
    expect(groups).toEqual([g('g2', 'Repair', ['c4', 'c2'])]);
    expect(looseCodes(unfiled, groups).map((c) => c.id)).toEqual(['c1']);
  });
});

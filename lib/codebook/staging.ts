/**
 * staging — PURE logic for the canvas staging box: loose codes, provisionally grouped,
 * before they are committed to the scheme.
 *
 * WHAT A GROUP IS. Nothing, until you promote it. A group is "a facet value you have
 * not named yet". Dragging three codes together says *these belong to one thing*; hitting
 * Promote says *and that thing is called X*, at which point it becomes a real
 * cb_facet_value and its members become codes answering it. There is no third
 * mechanism, no `cb_groups` table, and no second hierarchy to keep in sync — the
 * inductive path lands in exactly the structure the deductive path builds.
 *
 * This is axial coding: categories EMERGE from grouped observations rather than being
 * imposed from a paper. It is the exact inverse of the deductive pin, and both paths
 * are legitimate — but they must terminate in the same schema or the codebook ends up
 * with two kinds of category that mean different things.
 *
 * WHY GROUPS ARE CLIENT-SIDE (localStorage), not rows: a group that persists as a DB
 * row is a category you have committed to without naming. That is exactly the artefact
 * that rots — half-formed clusters nobody remembers the reason for, surviving in the
 * schema because deleting them feels like losing work. Keeping them provisional forces
 * the question "what IS this?" while the answer is still fresh, and makes abandoning a
 * bad grouping free.
 *
 * A CODE IS "UNFILED" when it gives no answer on the dimension being staged. It may
 * well answer OTHER dimensions — being filed on Space says nothing about whether it is
 * filed on Locus — so unfiled is always relative to one facet, never global.
 */

export type StagedGroup = {
  id: string;
  /** Empty until promoted — the group exists precisely to hold the un-named case. */
  name: string;
  codeIds: string[];
};

type Placeable = { id: string; facetValueIds: string[] };

/**
 * Codes with no answer on this facet. `facetValueIds` is the id set of the DIMENSION
 * being staged (all of its values, at every depth) — a code answering a nested value
 * IS filed, because a child value is still a value of the dimension, and demanding it
 * answer the parent too would be asking for a claim it already made more precisely.
 */
export function unfiledCodes<C extends Placeable>(
  codes: C[],
  facetValueIds: ReadonlySet<string>,
): C[] {
  return codes.filter((c) => !c.facetValueIds.some((id) => facetValueIds.has(id)));
}

/**
 * Move `codeId` into `groupId`, removing it from every other group first.
 *
 * A code belongs to AT MOST ONE staged group: a group becomes a facet value, and while
 * a code may legitimately answer two values of a `multi` dimension, expressing that by
 * sitting in two un-named clusters is unreadable — you cannot see what either cluster
 * IS. Cross-cutting is a claim you make once the values exist and are named, not a
 * property you smuggle in through the staging area.
 */
export function assignToGroup(
  groups: StagedGroup[],
  codeId: string,
  groupId: string,
): StagedGroup[] {
  // A groupId that names no group is a NO-OP, not a strip. Without this guard the
  // "remove from every other group" pass still runs and the code is silently pulled out
  // of the group it was in and put nowhere — a stale id (a group promoted in another
  // tab, a dropped drag) would quietly destroy a grouping instead of doing nothing.
  if (!groups.some((g) => g.id === groupId)) return groups;

  return groups.map((g) => ({
    ...g,
    codeIds:
      g.id === groupId
        ? g.codeIds.includes(codeId)
          ? g.codeIds
          : [...g.codeIds, codeId]
        : g.codeIds.filter((id) => id !== codeId),
  }));
}

/** Pull a code back out to the loose pile, leaving the group in place (possibly empty:
 *  an empty group is a category you have decided is real but not yet populated, which
 *  is a legitimate mid-sort state). */
export function removeFromGroups(groups: StagedGroup[], codeId: string): StagedGroup[] {
  return groups.map((g) => ({ ...g, codeIds: g.codeIds.filter((id) => id !== codeId) }));
}

/**
 * Start a group from two codes — the drop of one code onto another. `newId` is passed
 * in rather than generated, because a module that calls crypto.randomUUID() is no
 * longer pure and cannot be replayed in a test.
 */
export function groupFromPair(
  groups: StagedGroup[],
  newId: string,
  a: string,
  b: string,
): StagedGroup[] {
  // Both codes leave whatever group they were in — a code lives in at most one.
  const cleaned = removeFromGroups(removeFromGroups(groups, a), b);
  return [...cleaned, { id: newId, name: '', codeIds: a === b ? [a] : [a, b] }];
}

/** Drop empty, un-named groups. Called after a promote or a drag-out, so the box does
 *  not accumulate husks of clusters the researcher already abandoned. */
export function pruneGroups(groups: StagedGroup[]): StagedGroup[] {
  return groups.filter((g) => g.codeIds.length > 0 || g.name.trim() !== '');
}

/** The group a code currently sits in, or null when it is loose. */
export function groupOf(groups: StagedGroup[], codeId: string): StagedGroup | null {
  return groups.find((g) => g.codeIds.includes(codeId)) ?? null;
}

/** Codes in neither group nor scheme — the loose pile. */
export function looseCodes<C extends Placeable>(
  unfiled: C[],
  groups: StagedGroup[],
): C[] {
  const grouped = new Set(groups.flatMap((g) => g.codeIds));
  return unfiled.filter((c) => !grouped.has(c.id));
}

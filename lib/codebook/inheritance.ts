/**
 * inheritance — PURE roll-up of codes up a facet's value chain.
 *
 * A facet's values are an IS-A chain, not a folder hierarchy:
 *
 *     Space
 *       Experiment          <- a code answering Design ALSO answers Experiment
 *         Design
 *         Execution
 *
 * So a code that answers `Design` genuinely answers `Experiment` — that is
 * entailment, not a display convenience. A parent value must therefore show the codes
 * of its whole subtree.
 *
 * This REVERSES the rule that held while the canvas drew an arbitrary label tree,
 * where direct-only counts were correct because a folder asserted nothing about its
 * contents ("a parent claiming 12 codes that vanish when you zoom in is a lie"). Once
 * the tree is a taxonomy, the parent's claim is TRUE and hiding it is the lie.
 *
 * Storage stays minimal as a consequence: only the DEEPEST value a code answers is
 * stored, and ancestors are derived here. Storing both would let them disagree, and
 * would make "which granularity did this code actually claim?" unanswerable.
 *
 * DIRECT vs INHERITED is kept distinct in the result, because they are different
 * claims: a code pinned AT `Experiment` said "experiment, and I decline to be finer";
 * a code inherited from `Design` said something more precise. Collapsing them would
 * destroy the distinction the value chain exists to record.
 */

export type ValueRow = { id: string; parent_id: string | null };

export type ValueCodes<C> = {
  /** Codes that answer this value exactly. */
  direct: C[];
  /** Codes that answer some DESCENDANT of it, and so answer it by entailment. */
  inherited: C[];
};

/**
 * For every value, the codes that answer it directly and the codes that answer it by
 * inheritance from below.
 *
 * `codeValueIds(code)` returns the value ids a code carries (across all facets — ids
 * not present in `values` are simply ignored, so one facet's chain can be rolled up
 * without filtering the codes first).
 *
 * A code answering BOTH a parent and one of its descendants — which the UI is built
 * to prevent, but which a hand-edited row or an older record could still contain —
 * counts as DIRECT on the parent and is not double-listed as inherited there. Direct
 * wins, because the explicit claim is the stronger evidence of intent.
 *
 * A `parent_id` cycle in the data cannot hang the upward walk (visited-guard).
 */
export function rollUpByValue<C>(
  values: ValueRow[],
  codes: C[],
  codeValueIds: (code: C) => string[],
): Map<string, ValueCodes<C>> {
  const parentOf = new Map<string, string | null>();
  for (const v of values) parentOf.set(v.id, v.parent_id);

  const out = new Map<string, ValueCodes<C>>();
  for (const v of values) out.set(v.id, { direct: [], inherited: [] });

  for (const code of codes) {
    const answered = codeValueIds(code).filter((id) => parentOf.has(id));
    const directSet = new Set(answered);

    // Everything this code reaches by walking UP from each answered value.
    const inheritedSet = new Set<string>();
    for (const start of answered) {
      let cur = parentOf.get(start) ?? null;
      const seen = new Set<string>();
      while (cur != null && !seen.has(cur)) {
        seen.add(cur);
        inheritedSet.add(cur);
        cur = parentOf.get(cur) ?? null;
      }
    }

    for (const id of directSet) out.get(id)!.direct.push(code);
    for (const id of inheritedSet) {
      // Direct wins: never list a code as inherited on a value it answers outright.
      if (!directSet.has(id)) out.get(id)!.inherited.push(code);
    }
  }

  return out;
}

/**
 * Does `code` answer `facet` at all — directly or at any depth? Used by the triage
 * queue: a code carrying only a CHILD value has answered the dimension, and demanding
 * an answer it has already given (more precisely) would make the queue unclearable.
 */
export function answersFacet(codeValueIds: string[], facetValueIds: Set<string>): boolean {
  return codeValueIds.some((id) => facetValueIds.has(id));
}

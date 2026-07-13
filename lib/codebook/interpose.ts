/**
 * interpose — PURE validation + planning for splicing a NEW node into an existing
 * edge of the codebook tree.
 *
 * The move it models: "this turned out too granular — I need an intermediary
 * parent." You pick a parent P and a SUBSET of P's children, and a fresh node M is
 * created under P with those children re-parented beneath it.
 *
 *      before                    after
 *        P                         P
 *      / | \                     /   \
 *     A  B  C      interpose    M     C
 *                  (P, [A,B])  / \
 *                             A   B
 *
 * A SUBSET, not all children, because the realistic move is pulling two of five
 * siblings down under a new construct — an "interpose everything" API would force
 * a second re-parent pass to undo the over-capture.
 *
 * Interpose touches NO code: codes hang off nodes via the cb_code_labels
 * many-to-many, and re-parenting a node changes none of those memberships. So
 * restructuring can never alter what a code means or which codes are applicable.
 * That is the whole reason a node is never codeable.
 *
 * `interpose` is the exact INVERSE of `deleteLabel` (which promotes a deleted
 * node's children up to its parent — see migration 32). Together the pair makes
 * abstraction reversible: interpose to add a layer, delete to dissolve one.
 *
 * A cycle is unreachable here by construction — M is brand new, so it can have no
 * descendants and cannot be its own ancestor. Cycle risk lives in `reparent`
 * (`wouldCreateCycle` in labelTree.ts), not here. What CAN go wrong is capturing a
 * node that is not actually a child of P, which would silently *move* it across the
 * tree while the researcher believed they were only adding a layer. That is what
 * this module refuses.
 */

/** Any adjacency-list row. Generic because the SAME move applies to a facet's nested
 *  VALUES as to labels — "this answer turned out too granular, it needs an
 *  intermediate one" is the same operation as "this construct is too granular". */
type Nested = { id: string; parent_id: string | null };

/** Why an interpose was refused. Rendered to the researcher verbatim. */
export type InterposeError =
  | { kind: 'empty_name' }
  | { kind: 'no_children'; message: string }
  | { kind: 'unknown_child'; childId: string }
  | { kind: 'not_a_child'; childId: string; actualParentId: string | null };

/** A validated interpose: create a node named `name` under `parentId`, then
 *  re-parent exactly `childIds` beneath it. */
export type InterposePlan = {
  parentId: string | null;
  name: string;
  childIds: string[];
};

/**
 * Validate an interpose against the current label set.
 *
 * Refuses when:
 *  - the new node has a blank name;
 *  - no children were selected (that is `addChild`, not `interpose` — a distinct
 *    action, so the caller is told rather than silently given an empty node);
 *  - a selected child id is not in `labels` at all (stale UI / concurrent delete);
 *  - a selected child's CURRENT parent is not `parentId`. This is the important
 *    one: capturing a non-child would relocate a node from elsewhere in the tree
 *    under the guise of "adding a layer here". `parentId: null` means interposing
 *    at the ROOT — the selected children must then be roots themselves.
 *
 * Returns the plan on success. Duplicate ids in `childIds` are de-duplicated
 * (selecting the same node twice is a UI artefact, not an error), and the original
 * selection order is preserved so the new node's sibling order is predictable.
 */
export function planInterpose(
  labels: Nested[],
  { parentId, name, childIds }: InterposePlan,
): { ok: true; plan: InterposePlan } | { ok: false; errors: InterposeError[] } {
  const errors: InterposeError[] = [];

  const trimmed = (name ?? '').trim();
  if (trimmed === '') errors.push({ kind: 'empty_name' });

  // Dedupe, preserving first-seen order.
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of childIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }

  if (unique.length === 0) {
    errors.push({
      kind: 'no_children',
      message:
        'Interpose needs at least one child to pull down. To add an empty node, use Add child.',
    });
  }

  const byId = new Map(labels.map((l) => [l.id, l]));
  for (const id of unique) {
    const child = byId.get(id);
    if (!child) {
      errors.push({ kind: 'unknown_child', childId: id });
      continue;
    }
    // `parent_id ?? null` normalises undefined/null to the root sentinel so
    // interposing at root correctly demands root-level children.
    const actual = child.parent_id ?? null;
    if (actual !== parentId) {
      errors.push({ kind: 'not_a_child', childId: id, actualParentId: actual });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { parentId, name: trimmed, childIds: unique } };
}

/** Human-readable rendering of a refusal, for the dialog. */
export function describeInterposeError(e: InterposeError): string {
  switch (e.kind) {
    case 'empty_name':
      return 'The new node needs a name.';
    case 'no_children':
      return e.message;
    case 'unknown_child':
      return `A selected node no longer exists (${e.childId}). Reload the tree.`;
    case 'not_a_child':
      return `A selected node is not a child of this parent — interposing it would MOVE it from elsewhere in the tree, not add a layer here. Re-parent it explicitly if that is what you meant.`;
  }
}

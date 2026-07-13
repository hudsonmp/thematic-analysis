/**
 * tree — PURE, row-agnostic adjacency-list logic.
 *
 * Extracted from labelTree because the SAME shape now appears twice: labels nest
 * (migration 32) and facet VALUES nest (migration 35). Rather than a second copy
 * of fold/descendants/cycle-check with `label` renamed to `value` — the kind of
 * duplication where the two copies drift and only one gets the bug fix — the logic
 * is parameterised over any row carrying `{id, parent_id, position, created_at}`.
 *
 * The domain meaning differs even though the mechanics do not:
 *   FACET  — a dimension; a question askable of every code ("which space?").
 *   VALUE  — an answer to it. Values NEST (Ranganathan's chain: a taxonomy inside
 *            one dimension), which is what a tree is genuinely good at.
 * Facets themselves never nest under one another: that would make one dimension
 * conditional on another, destroying the orthogonality that lets a cross-cutting
 * code carry two values instead of being duplicated into two branches.
 */

export type TreeRow = {
  id: string;
  parent_id: string | null;
  position: number;
  created_at: string;
};

export type TreeNode<T extends TreeRow> = T & { children: TreeNode<T>[] };

/** `position` ascending, `created_at` as the stable tiebreak within a sibling group. */
function compareSiblings(a: TreeRow, b: TreeRow): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.created_at.localeCompare(b.created_at);
}

/**
 * Fold flat rows into a forest: roots (`parent_id === null`) → nested children,
 * each sibling group ordered.
 *
 * A row whose `parent_id` names a MISSING row (partial load, out-of-sync delete) is
 * DEFENSIVELY treated as a root rather than dropped or crashed on, so the tree
 * always renders every row exactly once. Losing a code's value silently would be
 * worse than showing it in the wrong place, where it is visible and fixable.
 */
export function buildTree<T extends TreeRow>(rows: T[]): TreeNode<T>[] {
  const nodeById = new Map<string, TreeNode<T>>();
  for (const row of rows) nodeById.set(row.id, { ...row, children: [] });

  const roots: TreeNode<T>[] = [];
  for (const node of nodeById.values()) {
    const parent = node.parent_id != null ? nodeById.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  roots.sort(compareSiblings);
  for (const node of nodeById.values()) node.children.sort(compareSiblings);
  return roots;
}

/** All TRANSITIVE descendant ids under `id`, excluding `id`. Cycle-guarded. */
export function descendantIds<T extends TreeRow>(rows: T[], id: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parent_id == null) continue;
    const siblings = childrenByParent.get(row.parent_id);
    if (siblings) siblings.push(row.id);
    else childrenByParent.set(row.parent_id, [row.id]);
  }

  const out = new Set<string>();
  const stack = [...(childrenByParent.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (out.has(next)) continue; // a data cycle must not re-push forever
    out.add(next);
    const kids = childrenByParent.get(next);
    if (kids) stack.push(...kids);
  }
  return out;
}

/**
 * Would re-parenting `id` under `newParentId` close a loop? True iff the new parent
 * IS the row, or is one of its descendants. Promoting to top level (`null`) can
 * never cycle.
 */
export function wouldCreateCycle<T extends TreeRow>(
  rows: T[],
  id: string,
  newParentId: string | null,
): boolean {
  if (newParentId == null) return false;
  if (newParentId === id) return true;
  return descendantIds(rows, id).has(newParentId);
}

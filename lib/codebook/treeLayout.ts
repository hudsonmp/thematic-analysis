/**
 * treeLayout — PURE geometry for the codebook tree canvas.
 *
 * Turns the nested label forest (+ the codes placed on each node) into absolute
 * positions and edges. Pure and I/O-free so the geometry is unit-testable: layout
 * bugs are invisible in code review and miserable to debug through a screenshot,
 * and this is exactly the kind of logic that silently drifts (a node overlapping a
 * sibling by two pixels looks like a CSS problem for an hour).
 *
 * Coordinates are in ABSTRACT SLOT UNITS, not pixels: x counts leaf-slots, y
 * counts depth. The renderer scales them. That keeps the algorithm independent of
 * font size, zoom level, and node chrome.
 *
 * Algorithm — a one-pass tidy layout (a simplified Reingold–Tilford):
 *
 *   1. Every LEAF node consumes exactly one slot, laid left to right.
 *   2. Every INTERNAL node is centred over its children: x = midpoint of its
 *      first and last child.
 *
 * That is enough for a bare-bones tree and cannot produce overlaps, because
 * subtree widths never share a slot — each leaf owns its column outright.
 *
 * CODES are NOT laid out as tree nodes. A code is placed ON a node (the
 * cb_code_labels junction), so it renders as a chip attached to that node's card;
 * it never gets its own column. This is the layout consequence of "a node may hold
 * codes AND child nodes at once": if codes were columns, a node with three codes
 * and two child nodes would need five columns and the tree would be a mess of
 * mixed-kind children.
 */

import type { LabelNode } from '@/lib/codebook/labelTree';

export type PositionedNode = {
  id: string;
  name: string;
  /** Slot-space centre. Fractional for internal nodes centred over children. */
  x: number;
  /** Depth from the rendered root: 0 for the top row, 1 for its children, … */
  y: number;
  parentId: string | null;
  /** Number of direct child NODES (not codes) — drives the `+` affordances. */
  childCount: number;
  /** How many codes are placed on this node. Rendered as chips on its card. */
  codeCount: number;
};

export type Edge = { parentId: string; childId: string };

export type Layout = {
  nodes: PositionedNode[];
  edges: Edge[];
  /** Total slot columns consumed. 0 for an empty forest. */
  width: number;
  /** Deepest row index + 1. 0 for an empty forest. */
  height: number;
};

/**
 * Lay out a forest. `codeCountByLabel` supplies how many codes sit on each node —
 * DIRECT placements only, never the subtree roll-up: the chip row on a node must
 * show what is actually pinned there, not a count inherited from its descendants
 * (a parent showing "12 codes" that vanish when you zoom in is a lie).
 *
 * Multiple roots are laid side by side, so several independent trees ("folders")
 * coexist on one canvas.
 */
export function layoutTree(
  roots: LabelNode[],
  codeCountByLabel: ReadonlyMap<string, number> = new Map(),
): Layout {
  const nodes: PositionedNode[] = [];
  const edges: Edge[] = [];

  // Next free leaf column. Mutated as the walk consumes slots left to right.
  let cursor = 0;
  let maxDepth = -1;

  /** Place `node` and its subtree; returns the node's slot-space centre. */
  function place(node: LabelNode, depth: number, parentId: string | null): number {
    if (depth > maxDepth) maxDepth = depth;

    let x: number;
    if (node.children.length === 0) {
      // A leaf owns exactly one column.
      x = cursor;
      cursor += 1;
    } else {
      // Place children first, then centre this node between the outermost two.
      const childXs = node.children.map((child) => place(child, depth + 1, node.id));
      x = (childXs[0] + childXs[childXs.length - 1]) / 2;
    }

    nodes.push({
      id: node.id,
      name: node.name,
      x,
      y: depth,
      parentId,
      childCount: node.children.length,
      codeCount: codeCountByLabel.get(node.id) ?? 0,
    });
    if (parentId !== null) edges.push({ parentId, childId: node.id });
    return x;
  }

  for (const root of roots) place(root, 0, null);

  return { nodes, edges, width: cursor, height: maxDepth + 1 };
}

/**
 * The ancestor chain of `id`, ROOT-FIRST and EXCLUDING `id` itself.
 *
 * Drives the zoom: when the canvas focuses a node, its ancestors are not hidden —
 * they render dimmed/blurred above it and stay clickable, so zooming in never
 * strands the researcher with no way back up. Returns `[]` for a root, and for an
 * id that is not in the forest.
 */
export function ancestorsOf(roots: LabelNode[], id: string): LabelNode[] {
  const path: LabelNode[] = [];

  function walk(node: LabelNode, trail: LabelNode[]): boolean {
    if (node.id === id) {
      path.push(...trail);
      return true;
    }
    for (const child of node.children) {
      if (walk(child, [...trail, node])) return true;
    }
    return false;
  }

  for (const root of roots) {
    if (walk(root, [])) break;
  }
  return path;
}

/**
 * The subtree rooted at `id`, or `null` when absent. Focusing the canvas on a node
 * means laying out ONLY this subtree — which is why zoom works at any level, with
 * no special case for roots: focusing a root is just `subtreeAt(root.id)`.
 */
export function subtreeAt(roots: LabelNode[], id: string): LabelNode | null {
  for (const root of roots) {
    if (root.id === id) return root;
    const found = subtreeAt(root.children, id);
    if (found) return found;
  }
  return null;
}

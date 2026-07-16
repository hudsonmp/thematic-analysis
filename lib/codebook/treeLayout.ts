/**
 * treeLayout — PURE geometry for the codebook tree canvas.
 *
 * Turns a nested forest (+ the codes carrying each node) into absolute positions
 * and edges. The forest is now a FACET'S VALUE CHAIN — the answer taxonomy inside
 * one dimension — but the geometry is generic over anything with {id, name, children}. Pure and I/O-free so the geometry is unit-testable: layout
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
 * CODES are NOT laid out as tree nodes. A code CARRIES a value (the
 * cb_code_facet_values junction) and may carry several, so it renders as a chip on
 * the value it answers, never as a column of its own. If codes were columns, a value
 * with three codes and two sub-values would need five columns of mixed kinds — and a
 * code answering two values could not be drawn at all without duplicating it.
 */

/**
 * The minimum a thing needs to be drawn: an id, a display name, and children.
 * Deliberately NOT tied to labels or to facet values — the canvas now renders a
 * FACET'S VALUE CHAIN (an answer taxonomy inside one dimension), and previously
 * rendered a label tree. The geometry does not care which, and coupling it to
 * either would mean a second copy of this file the day the other one appears.
 */
export type LayoutNode = {
  id: string;
  name: string;
  children: LayoutNode[];
};

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
  roots: LayoutNode[],
  codeCountByLabel: ReadonlyMap<string, number> = new Map(),
): Layout {
  const nodes: PositionedNode[] = [];
  const edges: Edge[] = [];

  // Next free leaf column. Mutated as the walk consumes slots left to right.
  let cursor = 0;
  let maxDepth = -1;

  /** Place `node` and its subtree; returns the node's slot-space centre. */
  function place(node: LayoutNode, depth: number, parentId: string | null): number {
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
export function ancestorsOf(roots: LayoutNode[], id: string): LayoutNode[] {
  const path: LayoutNode[] = [];

  function walk(node: LayoutNode, trail: LayoutNode[]): boolean {
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
export function subtreeAt(roots: LayoutNode[], id: string): LayoutNode | null {
  for (const root of roots) {
    if (root.id === id) return root;
    const found = subtreeAt(root.children, id);
    if (found) return found;
  }
  return null;
}

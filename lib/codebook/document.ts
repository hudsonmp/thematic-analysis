/**
 * document — PURE assembly of the codebook into a readable, nested DOCUMENT (the
 * shape /codebook/view renders and prints).
 *
 * A codebook document is not the tree and not the matrix. It is the thing a coder
 * reads to learn the instrument and a reviewer reads to judge it: every code, in a
 * legible order, with its full anatomy.
 *
 * THE ORGANIZING CHOICE. A code answers several facets at once (many-to-many), so it
 * has no single home — "nest the codes" is under-specified until you pick ONE
 * dimension to nest by. This module nests by a chosen facet's value chain and lists
 * every other dimension as per-code metadata. A code that answers two values on the
 * organizing dimension is CROSS-LISTED (it appears under each), because a printed
 * codebook is read section by section and a code missing from a section it belongs to
 * is worse than one that appears twice. A code with no answer on the organizing
 * dimension lands in a trailing "Unfiled" group rather than being dropped.
 *
 * Nesting is by DIRECT answer, not the inherited roll-up: in a document, showing a
 * code under both `Experiment` and its child `Design` is noise (the reader is already
 * looking at the nested structure). The entailment is visible in the indentation, so
 * the code is printed once, at the value it actually answers.
 *
 * Pure and I/O-free, so the document's structure is unit-testable independently of how
 * it is styled or printed.
 */

import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { buildTree, type TreeNode } from '@/lib/codebook/tree';
import type { Tables } from '@/lib/types/cb-db';

type FacetValue = Tables<'cb_facet_values'>;

/** One value node in the document, with the codes that DIRECTLY answer it and its
 *  nested child values. */
export type DocNode = {
  value: FacetValue;
  depth: number;
  codes: CodeWithRefs[];
  children: DocNode[];
};

export type CodebookDocument = {
  /** The dimension the document is organized by. */
  organizingFacet: FacetWithValues;
  roots: DocNode[];
  /** Codes with no answer on the organizing dimension — listed after the tree so
   *  nothing is silently omitted. */
  unfiled: CodeWithRefs[];
  /** Total distinct codes represented (NOT the sum of section counts, which double-
   *  counts cross-listed codes — the header must not lie about how many codes exist). */
  codeCount: number;
};

const byMnemonic = (a: CodeWithRefs, b: CodeWithRefs) => a.mnemonic.localeCompare(b.mnemonic);

/**
 * Assemble the document. `organizingFacetId` selects the dimension to nest by;
 * defaults to the first enum facet. Returns `null` when there is no enum facet to
 * organize by (an empty scheme has no document to render).
 */
export function buildCodebookDocument(
  facets: FacetWithValues[],
  codes: CodeWithRefs[],
  organizingFacetId?: string,
): CodebookDocument | null {
  const enumFacets = facets.filter((f) => f.type === 'enum');
  const organizingFacet =
    enumFacets.find((f) => f.id === organizingFacetId) ?? enumFacets[0] ?? null;
  if (organizingFacet === null) return null;

  const valueIds = new Set(organizingFacet.values.map((v) => v.id));

  // Codes that DIRECTLY answer each value on the organizing dimension.
  const codesByValue = new Map<string, CodeWithRefs[]>();
  for (const code of codes) {
    for (const vid of code.facetValueIds) {
      if (!valueIds.has(vid)) continue; // an answer on a DIFFERENT dimension
      const bucket = codesByValue.get(vid);
      if (bucket) bucket.push(code);
      else codesByValue.set(vid, [code]);
    }
  }

  const toDoc = (node: TreeNode<FacetValue>, depth: number): DocNode => ({
    value: node,
    depth,
    codes: (codesByValue.get(node.id) ?? []).slice().sort(byMnemonic),
    children: node.children.map((c) => toDoc(c, depth + 1)),
  });
  const roots = buildTree(organizingFacet.values).map((n) => toDoc(n, 0));

  const unfiled = codes
    .filter((c) => !c.facetValueIds.some((id) => valueIds.has(id)))
    .sort(byMnemonic);

  return { organizingFacet, roots, unfiled, codeCount: codes.length };
}

/** Flatten a document to its nodes in reading (pre-)order — used by the renderer to
 *  emit one heading per value without re-walking the tree, and by tests. */
export function docNodesInOrder(roots: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  const walk = (n: DocNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

import { describe, expect, it } from 'vitest';
import { buildCodebookDocument, docNodesInOrder } from '@/lib/codebook/document';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';

function facet(id: string, values: { id: string; parent_id: string | null }[]): FacetWithValues {
  return {
    id,
    type: 'enum',
    label: id,
    cardinality: 'multi',
    values: values.map((v, i) => ({ ...v, label: v.id, position: i })),
  } as unknown as FacetWithValues;
}

function code(id: string, mnemonic: string, facetValueIds: string[]): CodeWithRefs {
  return { id, mnemonic, name: mnemonic, facetValueIds } as unknown as CodeWithRefs;
}

//  Space
//    hyp
//    exp
//      design
const SPACE = facet('space', [
  { id: 'hyp', parent_id: null },
  { id: 'exp', parent_id: null },
  { id: 'design', parent_id: 'exp' },
]);

describe('buildCodebookDocument', () => {
  it('nests codes under their DIRECT value on the organizing dimension', () => {
    const doc = buildCodebookDocument([SPACE], [code('c1', 'AAA', ['design'])])!;
    const design = docNodesInOrder(doc.roots).find((n) => n.value.id === 'design')!;
    expect(design.codes.map((c) => c.mnemonic)).toEqual(['AAA']);
    // NOT also listed under exp — the entailment shows in the nesting, printing it
    // twice is noise.
    const exp = docNodesInOrder(doc.roots).find((n) => n.value.id === 'exp')!;
    expect(exp.codes).toEqual([]);
  });

  it('CROSS-LISTS a code that answers two values on the organizing dimension', () => {
    // A code missing from a section it belongs to is worse than one shown twice, because
    // the document is read section by section.
    const doc = buildCodebookDocument([SPACE], [code('c1', 'AAA', ['hyp', 'design'])])!;
    const nodes = docNodesInOrder(doc.roots);
    expect(nodes.find((n) => n.value.id === 'hyp')!.codes.map((c) => c.mnemonic)).toEqual(['AAA']);
    expect(nodes.find((n) => n.value.id === 'design')!.codes.map((c) => c.mnemonic)).toEqual(['AAA']);
  });

  it('puts a code with no answer on the organizing dimension in Unfiled, never dropped', () => {
    const doc = buildCodebookDocument([SPACE], [code('c1', 'AAA', ['other-facet-val'])])!;
    expect(doc.unfiled.map((c) => c.mnemonic)).toEqual(['AAA']);
    expect(docNodesInOrder(doc.roots).every((n) => n.codes.length === 0)).toBe(true);
  });

  it('counts DISTINCT codes, not the sum of sections (cross-listing must not inflate)', () => {
    const doc = buildCodebookDocument([SPACE], [code('c1', 'AAA', ['hyp', 'design'])])!;
    expect(doc.codeCount).toBe(1); // appears in two sections, but there is ONE code
  });

  it('sorts codes within a value by mnemonic, for a stable printed order', () => {
    const doc = buildCodebookDocument(
      [SPACE],
      [code('c2', 'ZZZ', ['hyp']), code('c1', 'AAA', ['hyp'])],
    )!;
    const hyp = docNodesInOrder(doc.roots).find((n) => n.value.id === 'hyp')!;
    expect(hyp.codes.map((c) => c.mnemonic)).toEqual(['AAA', 'ZZZ']);
  });

  it('defaults to the first enum facet and honors an explicit organizing id', () => {
    const other = facet('locus', [{ id: 'l1', parent_id: null }]);
    expect(buildCodebookDocument([SPACE, other], [])!.organizingFacet.id).toBe('space');
    expect(buildCodebookDocument([SPACE, other], [], 'locus')!.organizingFacet.id).toBe('locus');
  });

  it('returns null when there is no enum facet to organize by', () => {
    const boolean = { id: 'b', type: 'boolean', label: 'b', values: [] } as unknown as FacetWithValues;
    expect(buildCodebookDocument([boolean], [])).toBeNull();
    expect(buildCodebookDocument([], [])).toBeNull();
  });

  it('carries depth through the nesting for the renderer to indent by', () => {
    const doc = buildCodebookDocument([SPACE], [])!;
    const nodes = docNodesInOrder(doc.roots);
    expect(nodes.find((n) => n.value.id === 'exp')!.depth).toBe(0);
    expect(nodes.find((n) => n.value.id === 'design')!.depth).toBe(1);
  });
});

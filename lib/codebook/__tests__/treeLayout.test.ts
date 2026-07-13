import { describe, expect, it } from 'vitest';
import { ancestorsOf, layoutTree, subtreeAt } from '@/lib/codebook/treeLayout';
import type { LabelNode } from '@/lib/codebook/labelTree';

/** Build a LabelNode; layout reads only `id`, `name`, `children`. */
function node(id: string, children: LabelNode[] = []): LabelNode {
  return { id, name: id, children } as unknown as LabelNode;
}

//        P                 the drawing: one parent, three children
//      / | \
//     A  B  C
const P = () => node('P', [node('A'), node('B'), node('C')]);

describe('layoutTree', () => {
  it('gives each leaf its own column and centres the parent over them', () => {
    const { nodes, width, height } = layoutTree([P()]);
    const at = (id: string) => nodes.find((n) => n.id === id)!;

    expect(at('A').x).toBe(0);
    expect(at('B').x).toBe(1);
    expect(at('C').x).toBe(2);
    // Centred between the OUTERMOST children — (0 + 2) / 2.
    expect(at('P').x).toBe(1);

    expect(at('P').y).toBe(0);
    expect(at('A').y).toBe(1);
    expect(width).toBe(3);
    expect(height).toBe(2);
  });

  it('centres a parent on a FRACTIONAL slot when it has an even number of children', () => {
    // Two children at 0 and 1 → the parent sits at 0.5, between them. An integer
    // rounding here would visibly skew the parent off the branch fork.
    const { nodes } = layoutTree([node('P', [node('A'), node('B')])]);
    expect(nodes.find((n) => n.id === 'P')!.x).toBe(0.5);
  });

  it('never lets subtrees overlap — every leaf owns its column outright', () => {
    // Two branches of differing depth/width side by side.
    const tree = node('R', [
      node('L', [node('L1'), node('L2')]),
      node('M'),
      node('N', [node('N1', [node('N1a')])]),
    ]);
    const { nodes, width } = layoutTree([tree]);
    const leafXs = ['L1', 'L2', 'M', 'N1a'].map(
      (id) => nodes.find((n) => n.id === id)!.x,
    );
    // Four leaves, four distinct consecutive columns, strictly increasing.
    expect(leafXs).toEqual([0, 1, 2, 3]);
    expect(new Set(leafXs).size).toBe(4);
    expect(width).toBe(4);
  });

  it('lays multiple roots side by side, so several trees ("folders") coexist', () => {
    const { nodes, width } = layoutTree([P(), node('Q', [node('D')])]);
    expect(nodes.find((n) => n.id === 'D')!.x).toBe(3); // after P's three leaves
    expect(nodes.find((n) => n.id === 'Q')!.x).toBe(3);
    expect(width).toBe(4);
  });

  it('emits one edge per parent→child link and none for a root', () => {
    const { edges } = layoutTree([P()]);
    expect(edges).toEqual([
      { parentId: 'P', childId: 'A' },
      { parentId: 'P', childId: 'B' },
      { parentId: 'P', childId: 'C' },
    ]);
  });

  it('reports DIRECT code placements, never the subtree roll-up', () => {
    // A parent claiming "12 codes" that vanish when you zoom into it is a lie:
    // the chip row must show what is actually pinned to THIS node.
    const counts = new Map([['P', 1], ['A', 4]]);
    const { nodes } = layoutTree([P()], counts);
    expect(nodes.find((n) => n.id === 'P')!.codeCount).toBe(1); // NOT 1 + 4
    expect(nodes.find((n) => n.id === 'A')!.codeCount).toBe(4);
    expect(nodes.find((n) => n.id === 'B')!.codeCount).toBe(0);
  });

  it('handles an empty forest without producing a phantom row', () => {
    expect(layoutTree([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});

describe('ancestorsOf', () => {
  const forest = [node('R', [node('M', [node('A'), node('B')])]), node('Q')];

  it('returns the chain ROOT-FIRST, excluding the node itself', () => {
    expect(ancestorsOf(forest, 'A').map((n) => n.id)).toEqual(['R', 'M']);
  });

  it('is empty for a root — zooming a root strands nobody', () => {
    expect(ancestorsOf(forest, 'R')).toEqual([]);
    expect(ancestorsOf(forest, 'Q')).toEqual([]);
  });

  it('is empty for an id that is not in the forest', () => {
    expect(ancestorsOf(forest, 'ghost')).toEqual([]);
  });
});

describe('subtreeAt', () => {
  const forest = [node('R', [node('M', [node('A')])])];

  it('finds a node at any depth, so zoom needs no root special case', () => {
    expect(subtreeAt(forest, 'M')?.id).toBe('M');
    expect(subtreeAt(forest, 'M')?.children.map((c) => c.id)).toEqual(['A']);
    expect(subtreeAt(forest, 'R')?.id).toBe('R');
  });

  it('returns null for an absent id rather than throwing', () => {
    expect(subtreeAt(forest, 'ghost')).toBeNull();
  });
});

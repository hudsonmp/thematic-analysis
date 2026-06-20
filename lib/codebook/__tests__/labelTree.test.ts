import { describe, it, expect } from 'vitest';
import {
  buildLabelTree,
  descendantIds,
  wouldCreateCycle,
  rollupCodesByLabel,
  type LabelNode,
} from '@/lib/codebook/labelTree';
import type { Tables } from '@/lib/types/cb-db';

type Label = Tables<'cb_labels'>;
type Code = Tables<'cb_codes'>;

// --- fixture builders -------------------------------------------------------
// Only the fields the module reads matter; the rest are filled with stable,
// inert values so the partial rows still satisfy the full Row type.

function label(
  id: string,
  parent_id: string | null,
  position: number,
  created_at = '2026-01-01T00:00:00.000Z',
): Label {
  return {
    id,
    parent_id,
    position,
    created_at,
    codebook_id: 'cb',
    color: null,
    name: id,
  };
}

function code(id: string, mnemonic: string): Code {
  return {
    id,
    mnemonic,
    codebook_id: 'cb',
    created_at: '2026-01-01T00:00:00.000Z',
    current_version_id: null,
    name: mnemonic,
    origin: 'manual',
    parent_code_id: null,
    retired_at: null,
    status: 'active',
    study_label: null,
  };
}

/** Collect the ids of a forest in depth-first pre-order, for compact assertions. */
function ids(nodes: LabelNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...ids(n.children)]);
}

describe('buildLabelTree', () => {
  it('nests children under their parent and keeps roots at top level', () => {
    const tree = buildLabelTree([
      label('root', null, 0),
      label('child', 'root', 0),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('root');
    expect(tree[0].children.map((c) => c.id)).toEqual(['child']);
  });

  it('orders each sibling group by position, then created_at as a tiebreak', () => {
    const tree = buildLabelTree([
      label('b', null, 1),
      label('a', null, 0),
      // a third + fourth root share position 0 → broken by created_at ascending.
      label('z', null, 0, '2026-03-01T00:00:00.000Z'),
      label('y', null, 0, '2026-02-01T00:00:00.000Z'),
    ]);
    // position 0 group first (a, then the created_at tiebreak y < z), then b.
    expect(tree.map((n) => n.id)).toEqual(['a', 'y', 'z', 'b']);
  });

  it('orders children within a parent the same way (position then created_at)', () => {
    const tree = buildLabelTree([
      label('p', null, 0),
      label('c2', 'p', 1),
      label('c1', 'p', 0),
    ]);
    expect(tree[0].children.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('builds a deep 3-level tree (grandchild nested under child under root)', () => {
    const tree = buildLabelTree([
      label('gc', 'c', 0),
      label('c', 'r', 0),
      label('r', null, 0),
    ]);
    expect(ids(tree)).toEqual(['r', 'c', 'gc']);
  });

  it('treats a label whose parent is MISSING from the input as a root', () => {
    const tree = buildLabelTree([
      label('orphan', 'ghost', 0), // parent "ghost" not present
      label('real', null, 1),
    ]);
    // orphan is promoted to a root; both appear exactly once, ordered by position.
    expect(tree.map((n) => n.id)).toEqual(['orphan', 'real']);
    expect(ids(tree)).toEqual(['orphan', 'real']);
  });

  it('returns an empty forest for empty input', () => {
    expect(buildLabelTree([])).toEqual([]);
  });
});

describe('descendantIds', () => {
  const labels = [
    label('r', null, 0),
    label('a', 'r', 0),
    label('b', 'r', 1),
    label('a1', 'a', 0),
    label('a1x', 'a1', 0),
  ];

  it('returns all transitive descendants, excluding the label itself', () => {
    expect(descendantIds(labels, 'r')).toEqual(new Set(['a', 'b', 'a1', 'a1x']));
  });

  it('walks deep / transitive chains (grandchild + great-grandchild)', () => {
    expect(descendantIds(labels, 'a')).toEqual(new Set(['a1', 'a1x']));
  });

  it('returns an empty set for a leaf', () => {
    expect(descendantIds(labels, 'a1x')).toEqual(new Set());
  });

  it('returns an empty set for an id absent from the labels', () => {
    expect(descendantIds(labels, 'nope')).toEqual(new Set());
  });
});

describe('wouldCreateCycle', () => {
  const labels = [
    label('r', null, 0),
    label('a', 'r', 0),
    label('a1', 'a', 0),
    label('other', null, 1),
  ];

  it('is true when the new parent IS the label itself (self-parent)', () => {
    expect(wouldCreateCycle(labels, 'a', 'a')).toBe(true);
  });

  it('is true when the new parent is a direct child', () => {
    expect(wouldCreateCycle(labels, 'a', 'a1')).toBe(true);
  });

  it('is true when the new parent is a transitive grandchild', () => {
    expect(wouldCreateCycle(labels, 'r', 'a1')).toBe(true);
  });

  it('is false for a null parent (promote to top level)', () => {
    expect(wouldCreateCycle(labels, 'a', null)).toBe(false);
  });

  it('is false for an unrelated label (no ancestry either way)', () => {
    expect(wouldCreateCycle(labels, 'a', 'other')).toBe(false);
  });

  it('is false when moving a node under an ancestor of its own (no loop)', () => {
    // moving a1 under r is fine — r is a1's ancestor, not its descendant.
    expect(wouldCreateCycle(labels, 'a1', 'r')).toBe(false);
  });
});

describe('rollupCodesByLabel', () => {
  // r → a → a1, and a sibling subtree r2 → b.
  const labels = [
    label('r', null, 0),
    label('a', 'r', 0),
    label('a1', 'a', 0),
    label('r2', null, 1),
    label('b', 'r2', 0),
  ];

  it('buckets a directly-tagged code under that label', () => {
    const codes = [code('c1', 'ALPHA')];
    const { byLabel, unlabeled } = rollupCodesByLabel(labels, codes, [
      { code_id: 'c1', label_id: 'r' },
    ]);
    expect(byLabel.get('r')?.map((c) => c.id)).toEqual(['c1']);
    expect(unlabeled).toEqual([]);
  });

  it('rolls a leaf-tagged code up to ALL of its ancestors', () => {
    const codes = [code('c1', 'ALPHA')];
    const { byLabel } = rollupCodesByLabel(labels, codes, [
      { code_id: 'c1', label_id: 'a1' },
    ]);
    // tagged at a1 → visible at a1, a, and r (the whole chain to root).
    expect(byLabel.get('a1')?.map((c) => c.id)).toEqual(['c1']);
    expect(byLabel.get('a')?.map((c) => c.id)).toEqual(['c1']);
    expect(byLabel.get('r')?.map((c) => c.id)).toEqual(['c1']);
  });

  it('dedups a code that carries two labels in the SAME subtree (once per folder)', () => {
    const codes = [code('c1', 'ALPHA')];
    // c1 tagged at both a (ancestor of a1) and a1 — both roll up through a and r.
    const { byLabel } = rollupCodesByLabel(labels, codes, [
      { code_id: 'c1', label_id: 'a' },
      { code_id: 'c1', label_id: 'a1' },
    ]);
    expect(byLabel.get('r')?.map((c) => c.id)).toEqual(['c1']); // not ['c1','c1']
    expect(byLabel.get('a')?.map((c) => c.id)).toEqual(['c1']);
    expect(byLabel.get('a1')?.map((c) => c.id)).toEqual(['c1']);
  });

  it('places a code with labels in two different subtrees under both', () => {
    const codes = [code('c1', 'ALPHA')];
    const { byLabel } = rollupCodesByLabel(labels, codes, [
      { code_id: 'c1', label_id: 'a1' }, // subtree under r
      { code_id: 'c1', label_id: 'b' }, // subtree under r2
    ]);
    expect(byLabel.get('r')?.map((c) => c.id)).toEqual(['c1']);
    expect(byLabel.get('r2')?.map((c) => c.id)).toEqual(['c1']);
    expect(byLabel.get('b')?.map((c) => c.id)).toEqual(['c1']);
  });

  it('orders codes within a bucket by mnemonic ascending', () => {
    const codes = [code('c1', 'ZETA'), code('c2', 'ALPHA'), code('c3', 'MIKE')];
    const { byLabel } = rollupCodesByLabel(labels, codes, [
      { code_id: 'c1', label_id: 'r' },
      { code_id: 'c2', label_id: 'r' },
      { code_id: 'c3', label_id: 'r' },
    ]);
    expect(byLabel.get('r')?.map((c) => c.mnemonic)).toEqual(['ALPHA', 'MIKE', 'ZETA']);
  });

  it('puts a code with NO labels in the unlabeled bucket, also mnemonic-ordered', () => {
    const codes = [code('c1', 'BRAVO'), code('c2', 'ALPHA')];
    const { byLabel, unlabeled } = rollupCodesByLabel(labels, codes, []);
    expect(byLabel.size).toBe(0);
    expect(unlabeled.map((c) => c.mnemonic)).toEqual(['ALPHA', 'BRAVO']);
  });

  it('ignores a membership row that names a label absent from the codebook', () => {
    const codes = [code('c1', 'ALPHA')];
    const { byLabel, unlabeled } = rollupCodesByLabel(labels, codes, [
      { code_id: 'c1', label_id: 'ghost' }, // stale membership
    ]);
    // no real label tagged → the code falls through to unlabeled, nothing bucketed.
    expect(byLabel.size).toBe(0);
    expect(unlabeled.map((c) => c.id)).toEqual(['c1']);
  });

  it('returns empty buckets and empty unlabeled for empty inputs', () => {
    const { byLabel, unlabeled } = rollupCodesByLabel([], [], []);
    expect(byLabel.size).toBe(0);
    expect(unlabeled).toEqual([]);
  });

  it('does NOT hang on a parent_id cycle in the data (a→b→a)', () => {
    // Malformed data: a and b are each other's parent (no DB would allow it, but
    // the upward walk must terminate via the per-walk visited-guard).
    const cyclic = [
      label('a', 'b', 0),
      label('b', 'a', 0),
    ];
    const codes = [code('c1', 'ALPHA')];
    const { byLabel } = rollupCodesByLabel(cyclic, codes, [
      { code_id: 'c1', label_id: 'a' },
    ]);
    // The walk visits a then b, then stops — the code lands in both, once each.
    expect(byLabel.get('a')?.map((c) => c.id)).toEqual(['c1']);
    expect(byLabel.get('b')?.map((c) => c.id)).toEqual(['c1']);
  });
});

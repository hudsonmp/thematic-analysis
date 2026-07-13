import { describe, expect, it } from 'vitest';
import { planInterpose } from '@/lib/codebook/interpose';
import type { Tables } from '@/lib/types/cb-db';

type Label = Tables<'cb_labels'>;

/** Minimal label stub — planInterpose reads only `id` and `parent_id`. */
function label(id: string, parentId: string | null): Label {
  return { id, parent_id: parentId } as unknown as Label;
}

//        P                A, B, C are P's children
//      / | \              D is a child of Q (elsewhere in the tree)
//     A  B  C             P and Q are roots
const LABELS: Label[] = [
  label('P', null),
  label('Q', null),
  label('A', 'P'),
  label('B', 'P'),
  label('C', 'P'),
  label('D', 'Q'),
];

describe('planInterpose', () => {
  it('pulls a SUBSET of a parent\'s children under a new node', () => {
    const res = planInterpose(LABELS, {
      parentId: 'P',
      name: 'Intermediary',
      childIds: ['A', 'B'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // C is untouched — interpose captures only what was selected.
    expect(res.plan).toEqual({ parentId: 'P', name: 'Intermediary', childIds: ['A', 'B'] });
  });

  it('REFUSES to capture a node that is not a child of the parent', () => {
    // The load-bearing guard: D lives under Q. Silently accepting it would MOVE D
    // across the tree while the researcher believed they were only adding a layer
    // under P — a structural edit disguised as an insertion.
    const res = planInterpose(LABELS, { parentId: 'P', name: 'X', childIds: ['A', 'D'] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toContainEqual({
      kind: 'not_a_child',
      childId: 'D',
      actualParentId: 'Q',
    });
  });

  it('interposes at the ROOT, where the children must themselves be roots', () => {
    const ok = planInterpose(LABELS, { parentId: null, name: 'Top', childIds: ['P', 'Q'] });
    expect(ok.ok).toBe(true);

    // A is a child of P, not a root — refused at the root level too.
    const bad = planInterpose(LABELS, { parentId: null, name: 'Top', childIds: ['A'] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors).toContainEqual({
      kind: 'not_a_child',
      childId: 'A',
      actualParentId: 'P',
    });
  });

  it('refuses an empty selection and names the action the caller actually wants', () => {
    const res = planInterpose(LABELS, { parentId: 'P', name: 'X', childIds: [] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0].kind).toBe('no_children');
    // The refusal must be actionable, not just a rejection.
    expect(res.errors[0]).toHaveProperty('message', expect.stringContaining('Add child'));
  });

  it('refuses a blank name (whitespace is not a name)', () => {
    const res = planInterpose(LABELS, { parentId: 'P', name: '   ', childIds: ['A'] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toContainEqual({ kind: 'empty_name' });
  });

  it('trims the name rather than storing the researcher\'s stray spaces', () => {
    const res = planInterpose(LABELS, { parentId: 'P', name: '  Impasse  ', childIds: ['A'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.name).toBe('Impasse');
  });

  it('dedupes a doubly-selected child, preserving first-seen order', () => {
    const res = planInterpose(LABELS, {
      parentId: 'P',
      name: 'X',
      childIds: ['B', 'A', 'B'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.childIds).toEqual(['B', 'A']);
  });

  it('reports a stale child id rather than silently dropping it', () => {
    const res = planInterpose(LABELS, { parentId: 'P', name: 'X', childIds: ['A', 'ghost'] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toContainEqual({ kind: 'unknown_child', childId: 'ghost' });
  });

  it('accumulates every error, so the dialog can show all of them at once', () => {
    const res = planInterpose(LABELS, { parentId: 'P', name: '', childIds: ['D', 'ghost'] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.kind).sort()).toEqual([
      'empty_name',
      'not_a_child',
      'unknown_child',
    ]);
  });
});

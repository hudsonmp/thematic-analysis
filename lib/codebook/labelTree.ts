/**
 * labelTree — PURE logic that folds a codebook's flat `cb_labels` rows (each with
 * a self-referential `parent_id`) into a nested folder tree, plus the roll-up that
 * places every CODE under the labels (and ancestor labels) it is tagged with.
 *
 * Context: a label is the categorical "what kind" axis for codes (see
 * app/actions/labels.ts). Once labels carry `parent_id`, the codebook can be
 * browsed Finder-style — `Scientific Reasoning → Experimentation → Hypothesizing`
 * — and a parent folder represents its WHOLE subtree: clicking it shows every code
 * tagged anywhere beneath it (roll-up), not just codes tagged on the parent itself.
 *
 * This module is I/O-free (no DOM, no DB, no `server-only` bound) so the policy is
 * unit-testable, mirroring the `anchor.ts` / `folderGrouping.ts` pure-module
 * pattern. The single read path (`listCodebookTree`) already loads `labels[] +
 * codes[] + cb_code_labels memberships`; the folder view is then a linear
 * in-memory fold over data already in hand.
 */

import type { Tables } from '@/lib/types/cb-db';

type Label = Tables<'cb_labels'>;
type Code = Tables<'cb_codes'>;

/** A label plus its (recursively nested) child labels, in sibling display order. */
export type LabelNode = Label & { children: LabelNode[] };

/** One (code_id, label_id) membership row from the cb_code_labels junction. */
type CodeLabel = { code_id: string; label_id: string };

/**
 * Order two siblings by `position` ascending, then `created_at` ascending as a
 * stable tiebreak for rows that share a position — the same display order the
 * `listLabels` query uses, applied here per sibling group.
 */
function compareSiblings(a: Label, b: Label): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.created_at.localeCompare(b.created_at);
}

/**
 * Fold flat labels into a forest: roots (`parent_id === null`) → nested children,
 * each sibling group ordered by `position` then `created_at`.
 *
 * A label whose `parent_id` points to a MISSING label (the parent is absent from
 * the input — e.g. a partial load, or an out-of-sync delete) is DEFENSIVELY
 * treated as a root rather than dropped or crashed on, so the tree always renders
 * every label exactly once.
 */
export function buildLabelTree(labels: Label[]): LabelNode[] {
  // One node per label, children empty for now (filled in the linking pass).
  const nodeById = new Map<string, LabelNode>();
  for (const label of labels) {
    nodeById.set(label.id, { ...label, children: [] });
  }

  const roots: LabelNode[] = [];
  for (const node of nodeById.values()) {
    const parent = node.parent_id != null ? nodeById.get(node.parent_id) : undefined;
    // null parent_id, OR a parent_id that names a label not in the input → root.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Order every sibling group (roots + each node's children) consistently.
  roots.sort(compareSiblings);
  for (const node of nodeById.values()) node.children.sort(compareSiblings);

  return roots;
}

/**
 * The set of all TRANSITIVE descendant ids under `labelId` (children, their
 * children, …), EXCLUDING `labelId` itself. Walks down the child adjacency built
 * from `parent_id`. Returns an empty set when `labelId` has no children (or is
 * absent from `labels`).
 */
export function descendantIds(labels: Label[], labelId: string): Set<string> {
  // Adjacency: parent id → its direct children ids.
  const childrenByParent = new Map<string, string[]>();
  for (const label of labels) {
    if (label.parent_id == null) continue;
    const siblings = childrenByParent.get(label.parent_id);
    if (siblings) siblings.push(label.id);
    else childrenByParent.set(label.parent_id, [label.id]);
  }

  const out = new Set<string>();
  const stack = [...(childrenByParent.get(labelId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue; // guard a data cycle from re-pushing forever
    out.add(id);
    const children = childrenByParent.get(id);
    if (children) stack.push(...children);
  }
  return out;
}

/**
 * Would reparenting `labelId` under `newParentId` create a cycle? True iff
 * `newParentId === labelId` (a label cannot be its own parent) OR `newParentId`
 * is a descendant of `labelId` (which would close a loop). A `null` new parent
 * (promote to top level) can never create a cycle → false. Guards
 * `setLabelParent`.
 */
export function wouldCreateCycle(
  labels: Label[],
  labelId: string,
  newParentId: string | null,
): boolean {
  if (newParentId == null) return false;
  if (newParentId === labelId) return true;
  return descendantIds(labels, labelId).has(newParentId);
}

/**
 * Roll codes up the label tree: for each code, for EACH label it is tagged with,
 * walk UP the ancestor chain (the label itself + all its ancestors) and add the
 * code to every one of those labels' buckets. A parent folder thus contains every
 * code tagged anywhere in its subtree (roll-up), deduped PER bucket so a code with
 * two labels in the same subtree appears once under their shared ancestor. A code
 * with NO labels lands in `unlabeled`.
 *
 * `codeLabels` are the (code_id, label_id) membership rows. Codes within each
 * bucket — and the `unlabeled` list — are ordered by `mnemonic` ascending. A
 * `parent_id` cycle in the data cannot hang the upward walk (visited-guard).
 */
export function rollupCodesByLabel(
  labels: Label[],
  codes: Code[],
  codeLabels: CodeLabel[],
): { byLabel: Map<string, Code[]>; unlabeled: Code[] } {
  // parent lookup + a label-existence set (a membership may name a stale label).
  const parentById = new Map<string, string | null>();
  for (const label of labels) parentById.set(label.id, label.parent_id);

  // code id → the label ids it is directly tagged with (existing labels only).
  const labelsByCode = new Map<string, string[]>();
  for (const { code_id, label_id } of codeLabels) {
    if (!parentById.has(label_id)) continue; // membership to a missing label → skip
    const ids = labelsByCode.get(code_id);
    if (ids) ids.push(label_id);
    else labelsByCode.set(code_id, [label_id]);
  }

  // Bucket id → the SET of code ids in it (dedup), resolved to Code[] at the end.
  const idsByLabel = new Map<string, Set<string>>();
  const unlabeledIds = new Set<string>();
  const codeById = new Map<string, Code>();

  for (const code of codes) {
    codeById.set(code.id, code);
    const direct = labelsByCode.get(code.id);
    if (!direct || direct.length === 0) {
      unlabeledIds.add(code.id);
      continue;
    }
    // For each direct label, walk up to the root, bucketing into every ancestor.
    for (const startId of direct) {
      const seen = new Set<string>(); // per-walk visited-guard against a data cycle
      let cur: string | null | undefined = startId;
      while (cur != null && !seen.has(cur)) {
        seen.add(cur);
        let bucket = idsByLabel.get(cur);
        if (!bucket) {
          bucket = new Set<string>();
          idsByLabel.set(cur, bucket);
        }
        bucket.add(code.id);
        cur = parentById.get(cur) ?? null;
      }
    }
  }

  const byMnemonic = (a: Code, b: Code) => a.mnemonic.localeCompare(b.mnemonic);
  const resolve = (ids: Iterable<string>): Code[] =>
    [...ids]
      .map((id) => codeById.get(id))
      .filter((c): c is Code => c !== undefined)
      .sort(byMnemonic);

  const byLabel = new Map<string, Code[]>();
  for (const [labelId, ids] of idsByLabel) byLabel.set(labelId, resolve(ids));

  return { byLabel, unlabeled: resolve(unlabeledIds) };
}

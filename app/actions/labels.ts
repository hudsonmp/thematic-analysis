'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { autoColor } from '@/lib/codebook/color';
import { wouldCreateCycle } from '@/lib/codebook/labelTree';
import { describeInterposeError, planInterpose } from '@/lib/codebook/interpose';
import type { Tables } from '@/lib/types/cb-db';

type Label = Tables<'cb_labels'>;

// ---------------------------------------------------------------------------
// Labels (codebook-scoped) — the CATEGORICAL / "what kind" axis for CODES.
//
// A "label" is a flat, researcher-created tag (e.g. "Metacognition", "Surface
// strategy") used to ORGANIZE/GROUP codes by theme. The researcher curates this
// PRESET vocabulary once per codebook — add / rename (and recolor) / reorder /
// delete — exactly like the flag taxonomy (cb_flag_types) and the preset
// episodes (cb_episodes). A code is then tagged with any number of labels via
// cb_code_labels (see `setCodeLabels`), mirroring the cb_code_episodes tagging.
//
// This axis is INDEPENDENT of: the temporal axis (cb_episodes /
// cb_code_episodes), facets (cb_facets), flag types, and observations.
//
// Writes go through `cbFrom` (service role; cb_labels' RLS is open to
// `authenticated`), mirroring flag-types.ts.
// ---------------------------------------------------------------------------

/**
 * List a codebook's labels in display order (`position`, then `created_at` as a
 * stable tiebreak for rows that share a position). Returns the full rows so the
 * manager UI can show name + color swatch.
 */
export async function listLabels(codebookId: string): Promise<Label[]> {
  await requireAuthUser();
  const { data, error } = await cbFrom('cb_labels')
    .select('*')
    .eq('codebook_id', codebookId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listLabels failed: ${error.message}`);
  return data ?? [];
}

/**
 * Create a label under a codebook. `parentId` is optional — when given, the new
 * label nests under that label (a sub-label); when omitted/null it is a top-level
 * label. `position` is appended after the current max OF THE SIBLING GROUP (labels
 * sharing this `parent_id`) so a new label lands at the end of its own folder.
 * `color` is an optional hex override; when omitted/empty it is AUTO-ASSIGNED from
 * the sibling-group `position` via `autoColor`, so the researcher never picks one.
 * A brand-new node can never form a cycle, so no cycle check is needed here.
 * Returns the inserted row.
 */
export async function createLabel(
  codebookId: string,
  { name, color, parentId }: { name: string; color?: string; parentId?: string | null },
): Promise<Label> {
  await requireAuthUser();
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('createLabel: name is required.');

  const parent_id = parentId ?? null;
  const position = await nextPosition(codebookId, parent_id);
  const { data, error } = await cbFrom('cb_labels')
    .insert({
      codebook_id: codebookId,
      name: trimmed,
      parent_id,
      // Explicit caller color wins; otherwise auto-assign by group position.
      color: color?.trim() || autoColor(position),
      position,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`createLabel failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Rename (and optionally recolor) a label. `color` is only patched when
 * explicitly provided; passing an empty string clears it.
 */
export async function renameLabel(
  id: string,
  { name, color }: { name?: string; color?: string },
): Promise<Label> {
  await requireAuthUser();
  const patch: { name?: string; color?: string | null } = {};
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('renameLabel: name cannot be empty.');
    patch.name = trimmed;
  }
  if (color !== undefined) patch.color = color.trim() || null;

  const { data, error } = await cbFrom('cb_labels')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`renameLabel failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Re-parent a label, moving it (and its whole subtree, which travels with it via
 * the children's unchanged `parent_id`) under `newParentId`, or to the top level
 * when `newParentId` is null. REJECTS the move when it would create a cycle —
 * making a label its own ancestor (`newParentId === id` or a descendant of `id`)
 * — checked in-memory via `wouldCreateCycle` over the codebook's current labels.
 * The moved label is appended to the END of the destination sibling group, so it
 * lands last in its new folder (the researcher can reorder afterwards).
 */
export async function setLabelParent(
  id: string,
  newParentId: string | null,
): Promise<Label> {
  await requireAuthUser();

  // Resolve the codebook so we can load the sibling set and run the cycle check.
  const target = await cbFrom('cb_labels')
    .select('codebook_id')
    .eq('id', id)
    .single();
  if (target.error || !target.data) {
    throw new Error(
      `setLabelParent failed: ${target.error?.message ?? 'label not found'}`,
    );
  }
  const codebookId = target.data.codebook_id;

  const all = await cbFrom('cb_labels').select('*').eq('codebook_id', codebookId);
  if (all.error) {
    throw new Error(`setLabelParent (load labels) failed: ${all.error.message}`);
  }
  if (wouldCreateCycle(all.data ?? [], id, newParentId)) {
    throw new Error(
      'setLabelParent: cannot move a label under itself or one of its descendants (would create a cycle).',
    );
  }

  // Append to the end of the destination sibling group.
  const position = await nextPosition(codebookId, newParentId);
  const { data, error } = await cbFrom('cb_labels')
    .update({ parent_id: newParentId, position })
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`setLabelParent failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Delete a label. Before deleting, PROMOTE its direct children up one level — set
 * their `parent_id` to this label's own `parent_id` — so a deleted folder collapses
 * up rather than orphaning its children to root or cascading the subtree away. The
 * label's own code tags cascade (cb_code_labels.label_id FK on delete cascade), so
 * no orphaned tag rows remain; the promoted children keep their tags. A no-op
 * promotion (no children) is harmless.
 */
export async function deleteLabel(id: string): Promise<void> {
  await requireAuthUser();

  // NON-ATOMIC: the fetch-parent → promote-children → delete sequence below is
  // three separate PostgREST statements, NOT a single transaction. A child label
  // inserted (or re-parented under `id`) in the window BETWEEN the promote UPDATE
  // and the DELETE would not be promoted to the grandparent; instead it would fall
  // to the migration's `on delete set null` safety net on `cb_labels.parent_id`,
  // orphaning it to root rather than collapsing it up one level. Acceptable for the
  // single-researcher-per-codebook use here (no concurrent writers); flagged for a
  // future transactional / RPC hardening (a `delete_label_promote_children` RPC).

  // Read this label's parent so its children can be re-parented to it (promote).
  const target = await cbFrom('cb_labels')
    .select('parent_id')
    .eq('id', id)
    .single();
  if (target.error || !target.data) {
    throw new Error(
      `deleteLabel failed: ${target.error?.message ?? 'label not found'}`,
    );
  }

  // Promote children up one level (safe no-op when the label has none).
  const promote = await cbFrom('cb_labels')
    .update({ parent_id: target.data.parent_id })
    .eq('parent_id', id);
  if (promote.error) {
    throw new Error(`deleteLabel (promote children) failed: ${promote.error.message}`);
  }

  const { error } = await cbFrom('cb_labels').delete().eq('id', id);
  if (error) throw new Error(`deleteLabel failed: ${error.message}`);
}

/**
 * Set `position` = array index for each label id, in the given order. Issued as
 * independent updates (Supabase has no single-statement bulk-reorder) and
 * awaited together; throws on the first error. Mirrors `reorderFlagTypes`.
 */
export async function reorderLabels(orderedIds: string[]): Promise<void> {
  await requireAuthUser();
  const results = await Promise.all(
    orderedIds.map((id, index) =>
      cbFrom('cb_labels').update({ position: index }).eq('id', id),
    ),
  );
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) throw new Error(`reorderLabels failed: ${firstError.message}`);
}

/**
 * Replace the full set of label tags on a code: delete every existing
 * cb_code_labels row for the code, then insert the new set. A no-op set (empty
 * array) just clears the tags. Mirrors `setCodeEpisodes` exactly — the junction
 * is a (code_id, label_id) PK, so we de-dupe to avoid a self-colliding insert.
 * `labelIds` are the codebook's labels (cb_labels) the code is grouped under;
 * they are codebook-scoped, not per-session.
 */
export async function setCodeLabels(codeId: string, labelIds: string[]): Promise<void> {
  await requireAuthUser();
  const del = await cbFrom('cb_code_labels').delete().eq('code_id', codeId);
  if (del.error) {
    throw new Error(`setCodeLabels (delete) failed: ${del.error.message}`);
  }
  const uniqueIds = [...new Set(labelIds)];
  if (uniqueIds.length === 0) return;
  const ins = await cbFrom('cb_code_labels').insert(
    uniqueIds.map((label_id) => ({ code_id: codeId, label_id })),
  );
  if (ins.error) {
    throw new Error(`setCodeLabels (insert) failed: ${ins.error.message}`);
  }
}

/**
 * Set (or clear) a NODE's note — the free text explaining why this grouping
 * exists and what it does/does not gather (migration 34).
 *
 * A note is what a node carries INSTEAD of a scheme. Nodes are never applied to
 * data, so they have no definition, no include-if/exclude-if, no facets: those
 * belong to codes. Passing an empty/blank string clears the note to NULL.
 */
export async function setLabelNote(id: string, note: string | null): Promise<Label> {
  await requireAuthUser();
  const trimmed = (note ?? '').trim();
  const { data, error } = await cbFrom('cb_labels')
    .update({ note: trimmed === '' ? null : trimmed })
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`setLabelNote failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * ATTACH one code to one node — an ADDITIVE placement.
 *
 * Deliberately NOT `setCodeLabels`, which is a delete-all-then-insert of a code's
 * whole label set: calling that from the tree to place a code at one node would
 * silently DROP its placements everywhere else. Since placement is many-to-many on
 * purpose (the same code may legitimately hang under two branches), the tree needs
 * a single-membership add that leaves the others alone.
 *
 * Idempotent: the junction PK is (code_id, label_id), so re-attaching where the
 * row already exists is upserted to a no-op rather than raising a duplicate-key
 * error — dropping a code twice onto the same node is a slip, not a failure.
 */
export async function attachCodeToLabel(codeId: string, labelId: string): Promise<void> {
  await requireAuthUser();
  const res = await cbFrom('cb_code_labels').upsert(
    { code_id: codeId, label_id: labelId },
    { onConflict: 'code_id,label_id', ignoreDuplicates: true },
  );
  if (res.error) {
    throw new Error(`attachCodeToLabel failed: ${res.error.message}`);
  }
}

/**
 * DETACH one code from one node, leaving its other placements intact. Removing a
 * code's LAST placement does not delete the code — it returns to the Unplaced
 * tray, which is the whole point of letting codes exist before they are
 * structured.
 */
export async function detachCodeFromLabel(codeId: string, labelId: string): Promise<void> {
  await requireAuthUser();
  const res = await cbFrom('cb_code_labels')
    .delete()
    .eq('code_id', codeId)
    .eq('label_id', labelId);
  if (res.error) {
    throw new Error(`detachCodeFromLabel failed: ${res.error.message}`);
  }
}

/**
 * INTERPOSE a new node into an existing edge: create `name` under `parentId`, then
 * re-parent exactly `childIds` beneath it. The "this turned out too granular, I
 * need an intermediary parent" move. The exact inverse of `deleteLabel`, which
 * dissolves a node by promoting its children up one level.
 *
 * Validation is PURE (`planInterpose`) — in particular it REFUSES to capture a node
 * that is not currently a child of `parentId`, which would relocate it from
 * elsewhere in the tree under the guise of adding a layer here.
 *
 * Touches no code: placements live in cb_code_labels and re-parenting a node
 * changes none of them. Restructuring therefore cannot alter what any code means.
 *
 * NON-ATOMIC (same caveat as `deleteLabel`): insert-then-re-parent is two
 * PostgREST statements, not a transaction. A crash between them leaves an empty
 * new node with no children captured — visible and trivially deletable, not
 * corrupting. Acceptable for the single-researcher-per-codebook use here.
 */
export async function interposeLabel(
  codebookId: string,
  { parentId, name, childIds }: { parentId: string | null; name: string; childIds: string[] },
): Promise<Label> {
  await requireAuthUser();

  const labels = await listLabels(codebookId);
  const planned = planInterpose(labels, { parentId, name, childIds });
  if (!planned.ok) {
    throw new Error(
      `interposeLabel refused: ${planned.errors.map(describeInterposeError).join(' ')}`,
    );
  }
  const plan = planned.plan;

  // The new node takes the position of the FIRST child it captures, so it appears
  // where the researcher was looking rather than appended to the end of the group.
  const firstCaptured = labels.find((l) => l.id === plan.childIds[0]);
  const position = firstCaptured?.position ?? 0;

  const created = await cbFrom('cb_labels')
    .insert({
      codebook_id: codebookId,
      name: plan.name,
      parent_id: plan.parentId,
      color: autoColor(position),
      position,
    })
    .select('*')
    .single();
  if (created.error || !created.data) {
    throw new Error(
      `interposeLabel (insert) failed: ${created.error?.message ?? 'no row returned'}`,
    );
  }
  const node: Label = created.data;

  // Re-parent the captured children under the new node. Their positions carry
  // over unchanged, so their relative order inside the new node is preserved.
  const moved = await cbFrom('cb_labels')
    .update({ parent_id: node.id })
    .in('id', plan.childIds);
  if (moved.error) {
    throw new Error(`interposeLabel (re-parent children) failed: ${moved.error.message}`);
  }

  return node;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Compute the next append position for a label WITHIN ITS SIBLING GROUP: (max
 * existing position among labels in `codebookId` sharing `parentId`) + 1, or 0 if
 * the group is empty. `position` orders siblings under a common parent, not the
 * whole codebook — a top-level group (`parentId == null`) and each parent's
 * children each have their own 0..n sequence.
 */
async function nextPosition(
  codebookId: string,
  parentId: string | null,
): Promise<number> {
  let query = cbFrom('cb_labels')
    .select('position')
    .eq('codebook_id', codebookId);
  // Filter to the sibling group: roots match `parent_id IS NULL`, children match
  // the exact parent id. (`.eq(..., null)` would emit `= null`, never true.)
  query = parentId == null ? query.is('parent_id', null) : query.eq('parent_id', parentId);

  const { data, error } = await query
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`nextPosition(cb_labels) failed: ${error.message}`);
  return data ? data.position + 1 : 0;
}

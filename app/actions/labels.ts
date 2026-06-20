'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { autoColor } from '@/lib/codebook/color';
import { wouldCreateCycle } from '@/lib/codebook/labelTree';
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

'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { autoColor } from '@/lib/codebook/color';
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
 * Create a label under a codebook. `position` is appended after the current max
 * so a new label lands at the end of the ordered list. `color` is an optional
 * hex override; when omitted/empty it is AUTO-ASSIGNED from the within-codebook
 * `position` via `autoColor`, so the researcher never picks one and no two
 * labels in the codebook share (or sit perceptually close to) a color. Returns
 * the inserted row.
 */
export async function createLabel(
  codebookId: string,
  { name, color }: { name: string; color?: string },
): Promise<Label> {
  await requireAuthUser();
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('createLabel: name is required.');

  const position = await nextPosition(codebookId);
  const { data, error } = await cbFrom('cb_labels')
    .insert({
      codebook_id: codebookId,
      name: trimmed,
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
 * Delete a label. Its code tags cascade (cb_code_labels.label_id FK on delete
 * cascade), so no orphaned tag rows remain.
 */
export async function deleteLabel(id: string): Promise<void> {
  await requireAuthUser();
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
 * Compute the next append position for a label: (max existing position within
 * the codebook) + 1, or 0 if none exist. Mirrors flag-types.ts `nextPosition`.
 */
async function nextPosition(codebookId: string): Promise<number> {
  const { data, error } = await cbFrom('cb_labels')
    .select('position')
    .eq('codebook_id', codebookId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`nextPosition(cb_labels) failed: ${error.message}`);
  return data ? data.position + 1 : 0;
}

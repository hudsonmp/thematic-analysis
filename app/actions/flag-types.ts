'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { autoColor } from '@/lib/codebook/color';
import type { Tables } from '@/lib/types/cb-db';
import { requireEditor } from '@/lib/auth/roles';

type FlagType = Tables<'cb_flag_types'>;

// ---------------------------------------------------------------------------
// Flag taxonomy (codebook-scoped) — Task 1 of the live co-observation feature.
//
// A "flag type" is a named, color-tagged label a co-observer can raise during a
// live session (e.g. "Confusion", "Aha", "Off-task"). The researcher curates this
// PRESET list once per codebook — exactly like the preset-episodes editor — then,
// in a later task, a live observation pins a flag type at the current timecode.
// This module covers ONLY the preset taxonomy (the per-observation rows arrive
// later). Writes go through `cbFrom` (service role; cb_flag_types' RLS is open to
// `authenticated`), mirroring episodes.ts.
// ---------------------------------------------------------------------------

/**
 * List a codebook's flag types in display order (`position`, then `created_at`
 * as a stable tiebreak for rows that share a position). Returns the full rows so
 * the manager UI can show label + color swatch.
 */
export async function listFlagTypes(codebookId: string): Promise<FlagType[]> {
  await requireAuthUser();
  const { data, error } = await cbFrom('cb_flag_types')
    .select('*')
    .eq('codebook_id', codebookId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listFlagTypes failed: ${error.message}`);
  return data ?? [];
}

/**
 * Create a flag type under a codebook. `position` is appended after the current
 * max so a new flag lands at the end of the ordered list. `color` is an optional
 * hex override; when omitted/empty it is AUTO-ASSIGNED from the within-codebook
 * `position` via `autoColor`, so the researcher never picks one and no two flag
 * types in the codebook share (or sit perceptually close to) a color. Returns
 * the inserted row.
 */
export async function createFlagType(
  codebookId: string,
  { label, color }: { label: string; color?: string },
): Promise<FlagType> {
  await requireEditor(); // viewers are read-only
  await requireAuthUser();
  const trimmed = (label ?? '').trim();
  if (!trimmed) throw new Error('createFlagType: label is required.');

  const position = await nextPosition(codebookId);
  const { data, error } = await cbFrom('cb_flag_types')
    .insert({
      codebook_id: codebookId,
      label: trimmed,
      // Explicit caller color wins; otherwise auto-assign by group position.
      color: color?.trim() || autoColor(position),
      position,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`createFlagType failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Rename (and optionally recolor) a flag type. `color` is only patched when
 * explicitly provided; passing an empty string clears it.
 */
export async function renameFlagType(
  id: string,
  { label, color }: { label?: string; color?: string },
): Promise<FlagType> {
  await requireEditor(); // viewers are read-only
  await requireAuthUser();
  const patch: { label?: string; color?: string | null } = {};
  if (label !== undefined) {
    const trimmed = label.trim();
    if (!trimmed) throw new Error('renameFlagType: label cannot be empty.');
    patch.label = trimmed;
  }
  if (color !== undefined) patch.color = color.trim() || null;

  const { data, error } = await cbFrom('cb_flag_types')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`renameFlagType failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Delete a flag type. (Per-observation rows referencing it arrive in a later
 * task; their FK will be defined `on delete cascade` then, as with episodes.)
 */
export async function deleteFlagType(id: string): Promise<void> {
  await requireEditor(); // viewers are read-only
  await requireAuthUser();
  const { error } = await cbFrom('cb_flag_types').delete().eq('id', id);
  if (error) throw new Error(`deleteFlagType failed: ${error.message}`);
}

/**
 * Set `position` = array index for each flag-type id, in the given order. Issued
 * as independent updates (Supabase has no single-statement bulk-reorder) and
 * awaited together; throws on the first error. Mirrors `reorderEpisodes`.
 */
export async function reorderFlagTypes(orderedIds: string[]): Promise<void> {
  await requireEditor(); // viewers are read-only
  await requireAuthUser();
  const results = await Promise.all(
    orderedIds.map((id, index) =>
      cbFrom('cb_flag_types').update({ position: index }).eq('id', id),
    ),
  );
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) throw new Error(`reorderFlagTypes failed: ${firstError.message}`);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Compute the next append position for a flag type: (max existing position
 * within the codebook) + 1, or 0 if none exist. Mirrors episodes.ts `nextPosition`.
 */
async function nextPosition(codebookId: string): Promise<number> {
  const { data, error } = await cbFrom('cb_flag_types')
    .select('position')
    .eq('codebook_id', codebookId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`nextPosition(cb_flag_types) failed: ${error.message}`);
  return data ? data.position + 1 : 0;
}

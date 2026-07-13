'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { type FacetType, DEFAULT_FACET_TYPE } from '@/lib/codebook/facet-types';
import { autoColor } from '@/lib/codebook/color';
import { describeInterposeError, planInterpose } from '@/lib/codebook/interpose';
import { wouldCreateCycle } from '@/lib/codebook/tree';
import type { Tables } from '@/lib/types/cb-db';

type Facet = Tables<'cb_facets'>;
type FacetValue = Tables<'cb_facet_values'>;

export type Cardinality = 'single' | 'multi';

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/**
 * Create a facet under a codebook. `position` is appended after the current max
 * so new facets land at the end of the ordered list. `type` defaults to 'enum'
 * (value-bearing); `boolean` / `open_text` are valueless and carry their datum
 * per code in cb_code_facet_fields, so the caller need not (and should not) add
 * values for them. `cardinality` only matters for enum but is stored regardless
 * (harmless default for the valueless kinds). Returns the inserted row.
 */
export async function createFacet(
  codebookId: string,
  {
    key,
    label,
    cardinality = 'single' as Cardinality,
    type = DEFAULT_FACET_TYPE,
  }: { key: string; label: string; cardinality?: Cardinality; type?: FacetType },
): Promise<Facet> {
  const position = await nextPosition('cb_facets', codebookId);
  const { data, error } = await cbFrom('cb_facets')
    .insert({ codebook_id: codebookId, key, label, cardinality, type, position })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`createFacet failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

export async function renameFacet(
  facetId: string,
  { label, description }: { label: string; description?: string },
): Promise<Facet> {
  const patch: { label: string; description?: string } = { label };
  if (description !== undefined) patch.description = description;
  const { data, error } = await cbFrom('cb_facets')
    .update(patch)
    .eq('id', facetId)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`renameFacet failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Set `position` = array index for each facet id, in the given order. Issued as
 * independent updates (Supabase has no single-statement bulk-reorder); awaited
 * together. Throws on the first error.
 */
export async function reorderFacets(orderedFacetIds: string[]): Promise<void> {
  const results = await Promise.all(
    orderedFacetIds.map((id, index) =>
      cbFrom('cb_facets').update({ position: index }).eq('id', id),
    ),
  );
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) throw new Error(`reorderFacets failed: ${firstError.message}`);
}

/** Delete a facet. Values cascade (cb_facet_values FK on delete cascade). */
export async function deleteFacet(facetId: string): Promise<void> {
  const { error } = await cbFrom('cb_facets').delete().eq('id', facetId);
  if (error) throw new Error(`deleteFacet failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Facet values
// ---------------------------------------------------------------------------

/**
 * Create a value under a facet. `position` is appended after the facet's current
 * max value position. `color` is an optional hex override; when omitted/empty it
 * is AUTO-ASSIGNED from the within-facet `position` via `autoColor`, so the
 * researcher never picks one and no two values on the SAME facet share (or sit
 * perceptually close to) a color. Returns the inserted row.
 */
export async function createFacetValue(
  facetId: string,
  {
    key,
    label,
    description,
    color,
    parentId,
  }: {
    key: string;
    label: string;
    description?: string;
    color?: string;
    /** Nest under another VALUE of the same facet (migration 35) — a sub-facet: a
     *  finer answer inside one dimension, NOT a facet conditional on another. */
    parentId?: string | null;
  },
): Promise<FacetValue> {
  const position = await nextPosition('cb_facet_values', facetId);
  const { data, error } = await cbFrom('cb_facet_values')
    .insert({
      facet_id: facetId,
      key,
      label,
      description: description ?? null,
      parent_id: parentId ?? null,
      // Explicit caller color wins; otherwise auto-assign by group position.
      color: color?.trim() || autoColor(position),
      position,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`createFacetValue failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * PROMOTE a code into a facet VALUE.
 *
 * The move this exists for: you wrote "Analysis of Behavior" as a CODE, gave it a
 * definition, and then found it wanted children — "they said the spec would match and
 * it didn't", "they saw a discrepancy but didn't update the spec". That is the symptom
 * of a category miscast as an observation.
 *
 *   A CODE is an OBSERVATION — you can point at a transcript line and say "there".
 *   A VALUE is an ANSWER — the place you file what you pointed at.
 *
 * If you cannot point until you have decided WHICH sub-thing happened, the thing is a
 * value, not a code. This converts it: the code's name becomes the value's label, its
 * definition becomes the value's description, and every code that was going to sit
 * under it can now simply ANSWER it.
 *
 * The code is RETIRED, not deleted. Its id may already be referenced by codings, and a
 * hard delete would erase the record that this thing was once coded — status 'retired'
 * keeps the audit trail and takes it out of active use. If it turns out to have been a
 * mistake, the value is deletable and the code un-retirable; nothing is lost.
 */
export async function promoteCodeToValue(
  codeId: string,
  facetId: string,
  parentValueId: string | null = null,
): Promise<FacetValue> {
  const code = await cbFrom('cb_codes')
    .select('id, name, current_version_id')
    .eq('id', codeId)
    .single();
  if (code.error || !code.data) {
    throw new Error(`promoteCodeToValue failed: ${code.error?.message ?? 'code not found'}`);
  }

  // The definition, if the code has one, becomes the value's description — the whole
  // point is that the thinking already done about this category is not thrown away.
  let description: string | null = null;
  if (code.data.current_version_id) {
    const version = await cbFrom('cb_code_versions')
      .select('definition')
      .eq('id', code.data.current_version_id)
      .maybeSingle();
    description = version.data?.definition ?? null;
  }

  const position = await nextPosition('cb_facet_values', facetId);
  const created = await cbFrom('cb_facet_values')
    .insert({
      facet_id: facetId,
      key: code.data.id, // breadcrumb: this value used to be that code
      label: code.data.name,
      description,
      parent_id: parentValueId,
      color: autoColor(position),
      position,
    })
    .select('*')
    .single();
  if (created.error || !created.data) {
    throw new Error(
      `promoteCodeToValue (insert value) failed: ${created.error?.message ?? 'no row returned'}`,
    );
  }

  const retired = await cbFrom('cb_codes')
    .update({ status: 'retired', retired_at: new Date().toISOString() })
    .eq('id', codeId);
  if (retired.error) {
    throw new Error(`promoteCodeToValue (retire code) failed: ${retired.error.message}`);
  }

  return created.data;
}

/**
 * DUPLICATE a value as a FLOATING root of the same facet: same label and description,
 * NO parent, and — critically — NO codes.
 *
 * The copy carries none of the original's code memberships, because a code's answer is a
 * claim about a specific value. Copying the memberships would silently assert that every
 * code answering the original also answers the copy, which is a claim nobody made.
 *
 * WHAT THIS IS FOR: relocating one value ("I want this over there instead") — duplicate,
 * drag it under the new parent, delete the original.
 *
 * WHAT IT IS NOT FOR, and the trap: reusing a recurring SUB-TAXONOMY. If you copy
 * `Design / Execution` under both `Experiment` and `Analysis`, you now have two `Design`
 * values in ONE dimension, and a coder who picks "Design" cannot say which they meant —
 * the answer set is no longer distinguishable, which is the one property a dimension must
 * have. A sub-chain that recurs under several parents is answerable INDEPENDENTLY of
 * them, which means it is a second DIMENSION, not a sub-answer. Duplication is the
 * symptom; a new facet is the cure.
 */
export async function duplicateFacetValue(valueId: string): Promise<FacetValue> {
  const src = await cbFrom('cb_facet_values')
    .select('facet_id, label, description, color')
    .eq('id', valueId)
    .single();
  if (src.error || !src.data) {
    throw new Error(`duplicateFacetValue failed: ${src.error?.message ?? 'value not found'}`);
  }

  const position = await nextPosition('cb_facet_values', src.data.facet_id);
  const { data, error } = await cbFrom('cb_facet_values')
    .insert({
      facet_id: src.data.facet_id,
      key: crypto.randomUUID(),
      label: src.data.label,
      description: src.data.description,
      color: src.data.color ?? autoColor(position),
      // Floating: a root of its own until you drag it somewhere. Sub-values are NOT
      // copied either — a duplicate is a seed, not a clone of a whole subtree, and
      // copying the chain would multiply the ambiguity above by its depth.
      parent_id: null,
      position,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`duplicateFacetValue failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/** Every value of one facet — the read the tree ops fold over. */
export async function listFacetValues(facetId: string): Promise<FacetValue[]> {
  const { data, error } = await cbFrom('cb_facet_values')
    .select('*')
    .eq('facet_id', facetId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listFacetValues failed: ${error.message}`);
  return data ?? [];
}

/**
 * Re-parent a value within its facet. REJECTS a move that would make a value its own
 * ancestor. A value can never move to a DIFFERENT facet: that would silently change
 * which question a code was answering, and every code carrying it would keep a value
 * on a dimension it was never classified along.
 */
export async function setFacetValueParent(
  valueId: string,
  newParentId: string | null,
): Promise<FacetValue> {
  const target = await cbFrom('cb_facet_values').select('facet_id').eq('id', valueId).single();
  if (target.error || !target.data) {
    throw new Error(`setFacetValueParent failed: ${target.error?.message ?? 'value not found'}`);
  }
  const siblings = await listFacetValues(target.data.facet_id);

  if (newParentId !== null && !siblings.some((v) => v.id === newParentId)) {
    throw new Error('setFacetValueParent: a value cannot be nested under another facet.');
  }
  if (wouldCreateCycle(siblings, valueId, newParentId)) {
    throw new Error(
      'setFacetValueParent: cannot move a value under itself or one of its descendants.',
    );
  }

  const position = await nextPosition('cb_facet_values', target.data.facet_id);
  const { data, error } = await cbFrom('cb_facet_values')
    .update({ parent_id: newParentId, position })
    .eq('id', valueId)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`setFacetValueParent failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * INTERPOSE a value: create `label` under `parentId` (null = top level of the facet),
 * then re-parent exactly `childIds` beneath it. "This answer turned out too granular
 * — it needs an intermediate one."
 *
 * Validation is PURE (`planInterpose`) and refuses to capture a value that is not
 * currently a child of `parentId` — accepting one would MOVE it from elsewhere in the
 * chain while presenting itself as "add a layer here".
 *
 * Touches no CODE: a code's membership is (code, value), and re-parenting a value
 * changes none of those rows. So the answer space can be restructured freely without
 * altering what any code was classified as.
 */
export async function interposeFacetValue(
  facetId: string,
  { parentId, label, childIds }: { parentId: string | null; label: string; childIds: string[] },
): Promise<FacetValue> {
  const values = await listFacetValues(facetId);

  const planned = planInterpose(values, { parentId, name: label, childIds });
  if (!planned.ok) {
    throw new Error(
      `interposeFacetValue refused: ${planned.errors.map(describeInterposeError).join(' ')}`,
    );
  }
  const plan = planned.plan;

  // Take the position of the first child captured, so the new value appears where
  // the researcher was looking rather than appended to the end of the group.
  const position = values.find((v) => v.id === plan.childIds[0])?.position ?? 0;

  const created = await cbFrom('cb_facet_values')
    .insert({
      facet_id: facetId,
      // The key must be unique within the facet and is never shown; a slug of the
      // label would collide the moment two branches use the same word.
      key: crypto.randomUUID(),
      label: plan.name,
      parent_id: plan.parentId,
      color: autoColor(position),
      position,
    })
    .select('*')
    .single();
  if (created.error || !created.data) {
    throw new Error(
      `interposeFacetValue (insert) failed: ${created.error?.message ?? 'no row returned'}`,
    );
  }

  const moved = await cbFrom('cb_facet_values')
    .update({ parent_id: created.data.id })
    .in('id', plan.childIds);
  if (moved.error) {
    throw new Error(`interposeFacetValue (re-parent) failed: ${moved.error.message}`);
  }

  return created.data;
}

export async function updateFacetValue(
  valueId: string,
  { label, description, color }: { label?: string; description?: string; color?: string },
): Promise<FacetValue> {
  const patch: { label?: string; description?: string; color?: string } = {};
  if (label !== undefined) patch.label = label;
  if (description !== undefined) patch.description = description;
  if (color !== undefined) patch.color = color;
  const { data, error } = await cbFrom('cb_facet_values')
    .update(patch)
    .eq('id', valueId)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`updateFacetValue failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

export async function reorderFacetValues(orderedValueIds: string[]): Promise<void> {
  const results = await Promise.all(
    orderedValueIds.map((id, index) =>
      cbFrom('cb_facet_values').update({ position: index }).eq('id', id),
    ),
  );
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) throw new Error(`reorderFacetValues failed: ${firstError.message}`);
}

/**
 * Delete a value, PROMOTING its children up one level first (to its own parent) so a
 * removed intermediate answer collapses rather than orphaning the finer answers
 * beneath it. The exact inverse of `interposeFacetValue`, which makes abstraction
 * reversible in both directions.
 *
 * Without the promote, the migration-35 `on delete set null` safety net would fire
 * and every child would jump to the TOP of the facet — silently flattening a chain
 * the researcher spent real thought building.
 *
 * NON-ATOMIC (as with deleteLabel): read-parent → promote → delete is three
 * statements, not a transaction. Acceptable for the single-researcher-per-codebook
 * use here; the DB net catches the pathological interleaving.
 */
export async function deleteFacetValue(valueId: string): Promise<void> {
  const target = await cbFrom('cb_facet_values')
    .select('parent_id')
    .eq('id', valueId)
    .single();
  if (target.error || !target.data) {
    throw new Error(`deleteFacetValue failed: ${target.error?.message ?? 'value not found'}`);
  }

  const promote = await cbFrom('cb_facet_values')
    .update({ parent_id: target.data.parent_id })
    .eq('parent_id', valueId);
  if (promote.error) {
    throw new Error(`deleteFacetValue (promote children) failed: ${promote.error.message}`);
  }

  const { error } = await cbFrom('cb_facet_values').delete().eq('id', valueId);
  if (error) throw new Error(`deleteFacetValue failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Compute the next append position for a child row: (max existing position
 * within the parent scope) + 1, or 0 if none exist. Read via cbFrom's client
 * (a cb_ table, so the guard is satisfied; we only call `.select`).
 *
 * The `cb_facets` / `cb_facet_values` cases are split because `cbFrom<T>` is
 * generic per literal table — passing a `'cb_facets' | 'cb_facet_values'`
 * union would narrow the usable `.eq()` columns to only those common to both.
 */
async function nextPosition(
  table: 'cb_facets' | 'cb_facet_values',
  parentId: string,
): Promise<number> {
  const result =
    table === 'cb_facets'
      ? await cbFrom('cb_facets')
          .select('position')
          .eq('codebook_id', parentId)
          .order('position', { ascending: false })
          .limit(1)
          .maybeSingle()
      : await cbFrom('cb_facet_values')
          .select('position')
          .eq('facet_id', parentId)
          .order('position', { ascending: false })
          .limit(1)
          .maybeSingle();
  if (result.error) throw new Error(`nextPosition(${table}) failed: ${result.error.message}`);
  return result.data ? result.data.position + 1 : 0;
}

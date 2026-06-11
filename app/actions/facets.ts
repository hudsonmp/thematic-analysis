'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { type FacetType, DEFAULT_FACET_TYPE } from '@/lib/codebook/facet-types';
import { autoColor } from '@/lib/codebook/color';
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
  { key, label, description, color }: { key: string; label: string; description?: string; color?: string },
): Promise<FacetValue> {
  const position = await nextPosition('cb_facet_values', facetId);
  const { data, error } = await cbFrom('cb_facet_values')
    .insert({
      facet_id: facetId,
      key,
      label,
      description: description ?? null,
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

export async function deleteFacetValue(valueId: string): Promise<void> {
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

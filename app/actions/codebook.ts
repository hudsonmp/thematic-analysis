'use server';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { cbFrom } from '@/lib/supabase/guard';
import type { Json } from '@/lib/types/cb-db';
import type { Tables } from '@/lib/types/cb-db';

// ---------------------------------------------------------------------------
// Row aliases (from the generated schema) for the aggregate the UI consumes.
// ---------------------------------------------------------------------------
type Codebook = Tables<'cb_codebooks'>;
type Facet = Tables<'cb_facets'>;
type FacetValue = Tables<'cb_facet_values'>;
type Code = Tables<'cb_codes'>;
type CodeVersion = Tables<'cb_code_versions'>;
type Citation = Tables<'cb_citations'>;

export type ShownStudy = { id: string; name: string; authored_data: Json };

export type FacetWithValues = Facet & { values: FacetValue[] };

export type CodeWithRefs = Code & {
  current: CodeVersion | null;
  facetValueIds: string[];
  citationIds: string[];
};

export type CodebookTree = {
  codebook: Codebook;
  facets: FacetWithValues[];
  codes: CodeWithRefs[];
  citations: Citation[];
};

/**
 * The shown study is the single `studies` row with `visibility='shown'`; the
 * codebook binds to it. READ-ONLY: study data is IRB-covered and never written
 * by this app, so we use the service-role client's `.from('studies').select()`
 * directly (the `cbFrom` guard is for cb_ WRITES only).
 */
export async function getShownStudy(): Promise<ShownStudy | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from('studies')
    .select('id, name, authored_data')
    .eq('visibility', 'shown')
    .maybeSingle();
  if (error) {
    console.error('[codebook] getShownStudy failed:', error.message);
    return null;
  }
  if (!data) return null;
  return { id: data.id, name: data.name, authored_data: data.authored_data };
}

/**
 * Idempotently return the codebook bound to the shown study. Finds the
 * `cb_codebooks` row whose `study_id` matches the shown study; if none exists,
 * inserts one (name = "<study name> codebook", method = schema default).
 * Throws if there is no shown study (nothing to bind to).
 */
export async function getOrCreateCodebook(): Promise<Codebook> {
  const study = await getShownStudy();
  if (!study) {
    throw new Error('No shown study to bind a codebook to (visibility=shown not found).');
  }

  // Look for an existing codebook bound to this study. Reads through the
  // service-role client are fine; only writes must route through cbFrom.
  const existing = await createServiceRoleClient()
    .from('cb_codebooks')
    .select('*')
    .eq('study_id', study.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing.error) {
    throw new Error(`getOrCreateCodebook read failed: ${existing.error.message}`);
  }
  if (existing.data) return existing.data;

  const { data, error } = await cbFrom('cb_codebooks')
    .insert({ study_id: study.id, name: `${study.name} codebook` })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`getOrCreateCodebook insert failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Aggregate read for the UI: the codebook plus its facets (each with its
 * ordered values), its codes (each with the current version row, the set of
 * facet-value ids tagged on it, and the set of citation ids linked to it), and
 * its citations. Facets/values are ordered by `position`; codes by `mnemonic`.
 *
 * Read-only — uses the service-role client directly. Joins are done in-memory
 * from a handful of flat selects (clearer + cheaper to reason about than deeply
 * nested PostgREST embeds across the version/junction tables).
 */
export async function listCodebookTree(codebookId: string): Promise<CodebookTree> {
  const supabase = createServiceRoleClient();

  const [
    codebookRes,
    facetsRes,
    valuesRes,
    codesRes,
    versionsRes,
    codeFacetValuesRes,
    codeCitationsRes,
    citationsRes,
  ] = await Promise.all([
    supabase.from('cb_codebooks').select('*').eq('id', codebookId).single(),
    supabase
      .from('cb_facets')
      .select('*')
      .eq('codebook_id', codebookId)
      .order('position', { ascending: true }),
    supabase.from('cb_facet_values').select('*').order('position', { ascending: true }),
    supabase
      .from('cb_codes')
      .select('*')
      .eq('codebook_id', codebookId)
      .order('mnemonic', { ascending: true }),
    supabase.from('cb_code_versions').select('*'),
    supabase.from('cb_code_facet_values').select('*'),
    supabase.from('cb_code_citations').select('*'),
    supabase.from('cb_citations').select('*').eq('codebook_id', codebookId),
  ]);

  const firstError =
    codebookRes.error ||
    facetsRes.error ||
    valuesRes.error ||
    codesRes.error ||
    versionsRes.error ||
    codeFacetValuesRes.error ||
    codeCitationsRes.error ||
    citationsRes.error;
  if (firstError) {
    throw new Error(`listCodebookTree read failed: ${firstError.message}`);
  }
  if (!codebookRes.data) {
    throw new Error(`listCodebookTree: codebook ${codebookId} not found`);
  }

  const facetRows = facetsRes.data ?? [];
  const valueRows = valuesRes.data ?? [];
  const codeRows = codesRes.data ?? [];
  const versionRows = versionsRes.data ?? [];
  const codeFacetValueRows = codeFacetValuesRes.data ?? [];
  const codeCitationRows = codeCitationsRes.data ?? [];
  const citationRows = citationsRes.data ?? [];

  // Restrict the cross-table sets to THIS codebook's scope. `cb_facet_values`,
  // `cb_code_versions`, and `cb_code_facet_values` are queried unfiltered above
  // (they key off facet/code ids, not codebook_id), so filter them in-memory.
  const facetIds = new Set(facetRows.map((f) => f.id));
  const codeIds = new Set(codeRows.map((c) => c.id));

  const valuesByFacet = new Map<string, FacetValue[]>();
  for (const v of valueRows) {
    if (!facetIds.has(v.facet_id)) continue;
    const list = valuesByFacet.get(v.facet_id) ?? [];
    list.push(v);
    valuesByFacet.set(v.facet_id, list);
  }

  const versionById = new Map<string, CodeVersion>();
  for (const ver of versionRows) {
    if (codeIds.has(ver.code_id)) versionById.set(ver.id, ver);
  }

  const facetValueIdsByCode = new Map<string, string[]>();
  for (const link of codeFacetValueRows) {
    if (!codeIds.has(link.code_id)) continue;
    const list = facetValueIdsByCode.get(link.code_id) ?? [];
    list.push(link.facet_value_id);
    facetValueIdsByCode.set(link.code_id, list);
  }

  const citationIdsByCode = new Map<string, string[]>();
  for (const link of codeCitationRows) {
    if (!codeIds.has(link.code_id)) continue;
    const list = citationIdsByCode.get(link.code_id) ?? [];
    list.push(link.citation_id);
    citationIdsByCode.set(link.code_id, list);
  }

  const facets: FacetWithValues[] = facetRows.map((f) => ({
    ...f,
    values: valuesByFacet.get(f.id) ?? [],
  }));

  const codes: CodeWithRefs[] = codeRows.map((c) => ({
    ...c,
    current: c.current_version_id ? versionById.get(c.current_version_id) ?? null : null,
    facetValueIds: facetValueIdsByCode.get(c.id) ?? [],
    citationIds: citationIdsByCode.get(c.id) ?? [],
  }));

  return {
    codebook: codebookRes.data,
    facets,
    codes,
    citations: citationRows,
  };
}

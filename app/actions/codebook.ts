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
type Episode = Tables<'cb_episodes'>;
type Label = Tables<'cb_labels'>;

export type ShownStudy = { id: string; name: string; authored_data: Json };

/** A facet plus its (enum-only) values. `type` rides along on the Facet row
 *  (migration 22); for boolean / open_text facets `values` is empty and the
 *  per-code datum is carried in `CodeWithRefs.facetFields` instead. */
export type FacetWithValues = Facet & { values: FacetValue[] };

/** The boolean / open_text datum a code carries on ONE valueless facet
 *  (cb_code_facet_fields). Present in `facetFields` iff the code has a row for
 *  that facet; absent means "unset". */
export type CodeFacetField = {
  facetId: string;
  boolValue: boolean | null;
  textValue: string | null;
};

export type CodeWithRefs = Code & {
  current: CodeVersion | null;
  facetValueIds: string[];
  /** Per-facet boolean / open_text fields (valueless facet types), keyed by
   *  facetId. Parallel to `facetValueIds`, which covers enum facets. */
  facetFields: CodeFacetField[];
  citationIds: string[];
  episodeIds: string[];
  labelIds: string[];
};

export type CodebookTree = {
  codebook: Codebook;
  facets: FacetWithValues[];
  codes: CodeWithRefs[];
  citations: Citation[];
  episodes: Episode[];
  labels: Label[];
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

  // Conflict-safe bind. The read-first path above handles the common case; this
  // upsert closes the check-then-insert race. The DB now enforces one codebook
  // per non-null study_id (constraint cb_codebooks_study_id_unique, migration
  // 06), so a concurrent caller that inserts between our read and write would
  // otherwise violate the constraint. `onConflict: 'study_id'` turns that
  // collision into a no-op update on the existing row, which we then re-select
  // and return — both callers converge on the same bound row.
  const upserted = await cbFrom('cb_codebooks')
    .upsert(
      { study_id: study.id, name: `${study.name} codebook` },
      { onConflict: 'study_id' },
    )
    .select('*')
    .single();
  if (!upserted.error && upserted.data) return upserted.data;

  // Defense in depth: if the upsert itself raced (or the driver surfaced the
  // unique violation rather than resolving it), the row now exists — re-read it.
  const reread = await createServiceRoleClient()
    .from('cb_codebooks')
    .select('*')
    .eq('study_id', study.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (reread.data) return reread.data;

  throw new Error(
    `getOrCreateCodebook insert failed: ${upserted.error?.message ?? 'no row returned'}`,
  );
}

/**
 * Aggregate read for the UI: the codebook plus its facets (each with its
 * ordered values), its codes (each with the current version row, the set of
 * facet-value ids tagged on it, the set of citation ids linked to it, the set
 * of preset-episode ids tagged on it, and the set of label ids tagged on it),
 * its citations, its preset episodes, and its labels. Facets/values are ordered
 * by `position`; codes by `mnemonic`; episodes and labels by `position`.
 *
 * Read-only — uses the service-role client directly. Joins are done in-memory
 * from a handful of flat selects (clearer + cheaper to reason about than deeply
 * nested PostgREST embeds across the version/junction tables).
 *
 * Two-phase to keep child reads CORRECT, not just cheap: PostgREST caps result
 * sets (default 1000 rows) and the junction/value/version tables carry no
 * `codebook_id` column, so an unfiltered `select('*')` on them ranges over
 * EVERY codebook. On a populated DB the cap can silently truncate the page and
 * drop rows belonging to THIS codebook before the in-memory filter ever sees
 * them. Phase 1 reads this codebook's parents (facets, codes, citations) to
 * collect their ids; phase 2 reads each child scoped with `.in(parentIds)`.
 */
export async function listCodebookTree(codebookId: string): Promise<CodebookTree> {
  const supabase = createServiceRoleClient();

  // Phase 1: this codebook's parents. Each is scoped by codebook_id, so these
  // are inherently in-scope and bounded by this codebook's size.
  const [codebookRes, facetsRes, codesRes, citationsRes, episodesRes, labelsRes] =
    await Promise.all([
      supabase.from('cb_codebooks').select('*').eq('id', codebookId).single(),
      supabase
        .from('cb_facets')
        .select('*')
        .eq('codebook_id', codebookId)
        .order('position', { ascending: true }),
      supabase
        .from('cb_codes')
        .select('*')
        .eq('codebook_id', codebookId)
        .order('mnemonic', { ascending: true }),
      supabase.from('cb_citations').select('*').eq('codebook_id', codebookId),
      supabase
        .from('cb_episodes')
        .select('*')
        .eq('codebook_id', codebookId)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true }),
      supabase
        .from('cb_labels')
        .select('*')
        .eq('codebook_id', codebookId)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true }),
    ]);

  const phase1Error =
    codebookRes.error ||
    facetsRes.error ||
    codesRes.error ||
    citationsRes.error ||
    episodesRes.error ||
    labelsRes.error;
  if (phase1Error) {
    throw new Error(`listCodebookTree read failed: ${phase1Error.message}`);
  }
  if (!codebookRes.data) {
    throw new Error(`listCodebookTree: codebook ${codebookId} not found`);
  }

  const facetRows = facetsRes.data ?? [];
  const codeRows = codesRes.data ?? [];
  const citationRows = citationsRes.data ?? [];
  const episodeRows = episodesRes.data ?? [];
  const labelRows = labelsRes.data ?? [];

  const facetIdList = facetRows.map((f) => f.id);
  const codeIdList = codeRows.map((c) => c.id);

  // Phase 2: children scoped to in-scope parent ids. `.in('x', [])` is skipped
  // entirely — with no parents there can be no children, and issuing the query
  // would be wasteful (and an empty `.in` is a footgun). Each child read keys
  // off a parent id, not codebook_id, so the `.in(...)` IS the scope: it caps
  // the result at this codebook's rows and dodges the cross-codebook 1000-row
  // truncation that an unfiltered select would hit.
  const [
    valuesRes,
    versionsRes,
    codeFacetValuesRes,
    codeFacetFieldsRes,
    codeCitationsRes,
    codeEpisodesRes,
    codeLabelsRes,
  ] = await Promise.all([
    facetIdList.length
      ? supabase
          .from('cb_facet_values')
          .select('*')
          .in('facet_id', facetIdList)
          .order('position', { ascending: true })
      : null,
    codeIdList.length
      ? supabase.from('cb_code_versions').select('*').in('code_id', codeIdList)
      : null,
    codeIdList.length
      ? supabase.from('cb_code_facet_values').select('*').in('code_id', codeIdList)
      : null,
    codeIdList.length
      ? supabase.from('cb_code_facet_fields').select('*').in('code_id', codeIdList)
      : null,
    codeIdList.length
      ? supabase.from('cb_code_citations').select('*').in('code_id', codeIdList)
      : null,
    codeIdList.length
      ? supabase.from('cb_code_episodes').select('*').in('code_id', codeIdList)
      : null,
    codeIdList.length
      ? supabase.from('cb_code_labels').select('*').in('code_id', codeIdList)
      : null,
  ]);

  const phase2Error =
    valuesRes?.error ||
    versionsRes?.error ||
    codeFacetValuesRes?.error ||
    codeFacetFieldsRes?.error ||
    codeCitationsRes?.error ||
    codeEpisodesRes?.error ||
    codeLabelsRes?.error;
  if (phase2Error) {
    throw new Error(`listCodebookTree read failed: ${phase2Error.message}`);
  }

  const valueRows = valuesRes?.data ?? [];
  const versionRows = versionsRes?.data ?? [];
  const codeFacetValueRows = codeFacetValuesRes?.data ?? [];
  const codeFacetFieldRows = codeFacetFieldsRes?.data ?? [];
  const codeCitationRows = codeCitationsRes?.data ?? [];
  const codeEpisodeRows = codeEpisodesRes?.data ?? [];
  const codeLabelRows = codeLabelsRes?.data ?? [];

  const valuesByFacet = new Map<string, FacetValue[]>();
  for (const v of valueRows) {
    const list = valuesByFacet.get(v.facet_id) ?? [];
    list.push(v);
    valuesByFacet.set(v.facet_id, list);
  }

  const versionById = new Map<string, CodeVersion>();
  for (const ver of versionRows) {
    versionById.set(ver.id, ver);
  }

  const facetValueIdsByCode = new Map<string, string[]>();
  for (const link of codeFacetValueRows) {
    const list = facetValueIdsByCode.get(link.code_id) ?? [];
    list.push(link.facet_value_id);
    facetValueIdsByCode.set(link.code_id, list);
  }

  const facetFieldsByCode = new Map<string, CodeFacetField[]>();
  for (const row of codeFacetFieldRows) {
    const list = facetFieldsByCode.get(row.code_id) ?? [];
    list.push({ facetId: row.facet_id, boolValue: row.bool_value, textValue: row.text_value });
    facetFieldsByCode.set(row.code_id, list);
  }

  const citationIdsByCode = new Map<string, string[]>();
  for (const link of codeCitationRows) {
    const list = citationIdsByCode.get(link.code_id) ?? [];
    list.push(link.citation_id);
    citationIdsByCode.set(link.code_id, list);
  }

  const episodeIdsByCode = new Map<string, string[]>();
  for (const link of codeEpisodeRows) {
    const list = episodeIdsByCode.get(link.code_id) ?? [];
    list.push(link.episode_id);
    episodeIdsByCode.set(link.code_id, list);
  }

  const labelIdsByCode = new Map<string, string[]>();
  for (const link of codeLabelRows) {
    const list = labelIdsByCode.get(link.code_id) ?? [];
    list.push(link.label_id);
    labelIdsByCode.set(link.code_id, list);
  }

  const facets: FacetWithValues[] = facetRows.map((f) => ({
    ...f,
    values: valuesByFacet.get(f.id) ?? [],
  }));

  const codes: CodeWithRefs[] = codeRows.map((c) => ({
    ...c,
    current: c.current_version_id ? versionById.get(c.current_version_id) ?? null : null,
    facetValueIds: facetValueIdsByCode.get(c.id) ?? [],
    facetFields: facetFieldsByCode.get(c.id) ?? [],
    citationIds: citationIdsByCode.get(c.id) ?? [],
    episodeIds: episodeIdsByCode.get(c.id) ?? [],
    labelIds: labelIdsByCode.get(c.id) ?? [],
  }));

  return {
    codebook: codebookRes.data,
    facets,
    codes,
    citations: citationRows,
    episodes: episodeRows,
    labels: labelRows,
  };
}

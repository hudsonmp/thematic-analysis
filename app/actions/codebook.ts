'use server';

import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { studyFrom } from '@/lib/supabase/study-guard';
import { cbFrom } from '@/lib/supabase/guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { requireEditor } from '@/lib/auth/roles';
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
 * by this app, so the read goes through `studyFrom` — the SELECT-only study-read
 * guard on the anon-key user client; study-table RLS grants `authenticated`
 * SELECT only, so a write on this path is refused by Postgres. (The `cbFrom`
 * guard remains the cb_ WRITE path.)
 */
export async function getShownStudy(): Promise<ShownStudy | null> {
  const studies = await studyFrom('studies');
  const { data, error } = await studies
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

// ---------------------------------------------------------------------------
// Active codebook — a study may now bind SEVERAL codebooks (the old
// UNIQUE(study_id) constraint is dropped). Which one the app shows is a
// PER-BROWSER choice carried in a cookie, not a per-user DB column: switching
// is a view preference, so it needs no table, no RLS, and no migration, and
// two browsers signed into the same account can look at different codebooks.
// Every server-side consumer resolves the codebook through
// `getOrCreateCodebook()`, so honoring the cookie there switches the WHOLE app
// (pages, session player, merge) with zero call-site
// changes.
// ---------------------------------------------------------------------------
const ACTIVE_CODEBOOK_COOKIE = 'cb-active-codebook';

/** Point this browser at `codebookId`. Cookie writes are legal only in Server
 *  Actions / Route Handlers (never during Server Component render), so this is
 *  called from `createCodebook` / `setActiveCodebook` — NOT from
 *  `getOrCreateCodebook`, whose fallback path deliberately leaves a stale
 *  cookie in place rather than trying (and failing) to heal it mid-render. */
async function writeActiveCodebookCookie(codebookId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_CODEBOOK_COOKIE, codebookId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
}

/**
 * Resolve the ACTIVE codebook for the shown study. Resolution order:
 *
 *   1. The `cb-active-codebook` cookie, iff it names a codebook that exists
 *      AND belongs to the shown study (a stale/foreign cookie is ignored).
 *   2. The OLDEST codebook bound to the study (`created_at` asc) — the stable
 *      default, and the pre-multi-codebook row for existing deployments.
 *   3. If the study has NO codebook yet, insert one
 *      (name = "<study name> codebook", method = schema default) and return it.
 *
 * Reading the cookie is legal here even when called from Server Components;
 * SETTING one is not, so a stale cookie is merely bypassed (the switcher UI
 * rewrites it on the next explicit switch). Throws if there is no shown study
 * (nothing to bind to).
 */
export async function getOrCreateCodebook(): Promise<Codebook> {
  const study = await getShownStudy();
  if (!study) {
    throw new Error('No shown study to bind a codebook to (visibility=shown not found).');
  }

  const service = createServiceRoleClient();

  // 1. Follow the per-browser cookie when it points at a codebook of THIS
  // study. Scoping the read by study_id makes a cookie forged/stale from
  // another study fall through to the default instead of leaking it.
  const cookieStore = await cookies();
  const activeId = cookieStore.get(ACTIVE_CODEBOOK_COOKIE)?.value;
  if (activeId) {
    const active = await service
      .from('cb_codebooks')
      .select('*')
      .eq('id', activeId)
      .eq('study_id', study.id)
      .maybeSingle();
    if (active.error) {
      throw new Error(`getOrCreateCodebook read failed: ${active.error.message}`);
    }
    if (active.data) return active.data;
  }

  // 2. No (valid) cookie — fall back to the study's oldest codebook. Reads
  // through the service-role client are fine; only writes must route through
  // cbFrom.
  const oldest = await service
    .from('cb_codebooks')
    .select('*')
    .eq('study_id', study.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (oldest.error) {
    throw new Error(`getOrCreateCodebook read failed: ${oldest.error.message}`);
  }
  if (oldest.data) return oldest.data;

  // 3. First visit ever: bind the study's first codebook. Plain insert — the
  // old `onConflict: 'study_id'` upsert is gone WITH its unique constraint
  // (multiple codebooks per study are now legal, so there is nothing to
  // conflict on). If two first visits race, both inserts succeed and the
  // oldest-first fallback above makes every later resolution converge on one
  // row; the stray twin is visible in the switcher and deletable by hand.
  const inserted = await cbFrom('cb_codebooks')
    .insert({ study_id: study.id, name: `${study.name} codebook` })
    .select('*')
    .single();
  if (inserted.error || !inserted.data) {
    throw new Error(
      `getOrCreateCodebook insert failed: ${inserted.error?.message ?? 'no row returned'}`,
    );
  }
  return inserted.data;
}

/**
 * All codebooks bound to the shown study, oldest first (`created_at` asc — the
 * same order that makes `getOrCreateCodebook`'s fallback deterministic).
 * Returns [] when there is no shown study so the nav shell can render instead
 * of 500-ing. Read-only via the service client.
 */
export async function listCodebooks(): Promise<Codebook[]> {
  await requireAuthUser();
  const study = await getShownStudy();
  if (!study) return [];
  const { data, error } = await createServiceRoleClient()
    .from('cb_codebooks')
    .select('*')
    .eq('study_id', study.id)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listCodebooks failed: ${error.message}`);
  return data ?? [];
}

/**
 * Create a NEW codebook under the shown study and make it this browser's
 * active codebook (cookie), so the creating editor lands in the empty book
 * ready to populate it. Editor-gated: the write goes through the service-role
 * `cbFrom`, which bypasses RLS, so the app-level gate is mandatory.
 */
export async function createCodebook(name: string): Promise<Codebook> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('createCodebook: name is required.');

  const study = await getShownStudy();
  if (!study) {
    throw new Error('No shown study to bind a codebook to (visibility=shown not found).');
  }

  const { data, error } = await cbFrom('cb_codebooks')
    .insert({ study_id: study.id, name: trimmed })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`createCodebook failed: ${error?.message ?? 'no row returned'}`);
  }

  await writeActiveCodebookCookie(data.id);
  return data;
}

/**
 * Rename a codebook. Editor-gated for the same reason as `createCodebook`.
 */
export async function renameCodebook(id: string, name: string): Promise<Codebook> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('renameCodebook: name cannot be empty.');

  const { data, error } = await cbFrom('cb_codebooks')
    .update({ name: trimmed })
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`renameCodebook failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Point THIS browser at another of the shown study's codebooks. Any signed-in
 * role may switch — the cookie only changes what this browser looks at, never
 * the data — but the target must belong to the shown study (a foreign or
 * unknown id throws rather than planting a cookie `getOrCreateCodebook` would
 * silently discard).
 */
export async function setActiveCodebook(id: string): Promise<void> {
  await requireAuthUser();
  const study = await getShownStudy();
  if (!study) {
    throw new Error('setActiveCodebook: no shown study.');
  }
  const { data, error } = await createServiceRoleClient()
    .from('cb_codebooks')
    .select('id')
    .eq('id', id)
    .eq('study_id', study.id)
    .maybeSingle();
  if (error) throw new Error(`setActiveCodebook read failed: ${error.message}`);
  if (!data) {
    throw new Error('setActiveCodebook: codebook not found for the shown study.');
  }
  await writeActiveCodebookCookie(id);
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
      // RETIRED codes are hidden here — this is the single spine every code
      // surface reads (codebook view, coding picker, exports, drill), so one
      // filter makes a merged/retired code disappear everywhere. `cb_merge_codes`
      // re-points an absorbed code's references to the survivor and stamps it
      // retired_at + status='merged' (kept, not deleted, for version-history &
      // audit provenance) — but WITHOUT this filter the retired row kept showing,
      // which reads as "the merge didn't delete it". Existing annotations coded
      // with a now-retired code are unaffected: they carry their own joined
      // mnemonic (listMyAnnotationsForVersion), not a lookup into this list.
      supabase
        .from('cb_codes')
        .select('*')
        .eq('codebook_id', codebookId)
        .is('retired_at', null)
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

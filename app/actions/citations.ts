'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { parseBibtex } from '@/lib/bibtex/parse';
import type { Json, Tables, TablesInsert, TablesUpdate } from '@/lib/types/cb-db';
import { requireEditor } from '@/lib/auth/roles';

type Citation = Tables<'cb_citations'>;

export type CitationRole = 'derived_from' | 'near_miss' | 'related';

/**
 * Paste a BibTeX blob and upsert each parsed entry into `cb_citations`.
 *
 * `parseBibtex` is conservative: it skips macros (@string/@preamble/@comment)
 * and malformed entries, so the parsed set may be smaller than the raw blob.
 * We additionally skip any entry without a `bibtex_key` — the unique key for the
 * upsert is `(codebook_id, bibtex_key)`, so a null key has nothing to dedupe on
 * and would let the same paste accrete duplicate rows. (The parser already
 * rejects empty/malformed keys, so this is belt-and-suspenders.)
 *
 * Re-pasting the SAME blob is idempotent at the row level: `onConflict` on the
 * `(codebook_id, bibtex_key)` unique constraint turns a repeat into an UPDATE of
 * title/authors/year/doi/url/bibtex_raw/parsed in place, not a new row. This is
 * the desired "re-paste to refresh metadata" behavior.
 *
 * `inserted` is the number of distinct entries written THIS call (insert OR
 * update) — i.e. the count of rows returned by the upsert, not a net delta of
 * new rows. The UI uses it as "n citations recognized from this paste".
 */
export async function addCitations(
  codebookId: string,
  blob: string,
): Promise<{ inserted: number; entries: Citation[] }> {
  const parsed = parseBibtex(blob);

  // De-dupe within the blob by bibtex_key (last wins) so a single upsert call
  // does not present two rows with the same conflict target — PostgREST rejects
  // an upsert whose payload collides with itself on the conflict columns.
  const byKey = new Map<string, TablesInsert<'cb_citations'>>();
  for (const c of parsed) {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
    if (!c.bibtex_key) continue; // no conflict target -> would duplicate; skip
    byKey.set(c.bibtex_key, {
      codebook_id: codebookId,
      bibtex_key: c.bibtex_key,
      bibtex_raw: c.bibtex_raw,
      title: c.title ?? null,
      authors: c.authors ?? null,
      year: c.year ?? null,
      doi: c.doi ?? null,
      url: c.url ?? null,
      parsed: c.parsed as Json,
    });
  }

  const rows = [...byKey.values()];
  if (rows.length === 0) return { inserted: 0, entries: [] };

  const res = await cbFrom('cb_citations')
    .upsert(rows, { onConflict: 'codebook_id,bibtex_key' })
    .select('*');
  if (res.error) {
    throw new Error(`addCitations failed: ${res.error.message}`);
  }

  const entries = res.data ?? [];
  return { inserted: entries.length, entries };
}

/**
 * Resolve a single citation by id, or null if it doesn't exist. Used by the
 * "code from citation" deductive-coding surface to render the bound-mode banner
 * ("Deriving codes from: <bibtex_key / title>") from a `fromCitation` param.
 * Returns null rather than throwing on a stale/unknown id so the surface can
 * silently fall back to the unbound form instead of 500-ing.
 */
export async function getCitation(citationId: string): Promise<Citation | null> {
  const res = await cbFrom('cb_citations').select('*').eq('id', citationId).maybeSingle();
  if (res.error) {
    throw new Error(`getCitation failed: ${res.error.message}`);
  }
  return res.data ?? null;
}

/** List a codebook's citations, oldest first (paste order). */
export async function listCitations(codebookId: string): Promise<Citation[]> {
  const res = await cbFrom('cb_citations')
    .select('*')
    .eq('codebook_id', codebookId)
    .order('created_at', { ascending: true });
  if (res.error) {
    throw new Error(`listCitations failed: ${res.error.message}`);
  }
  return res.data ?? [];
}

/**
 * Patch a citation's display metadata. Only the provided fields are written;
 * `bibtex_key`/`bibtex_raw`/`parsed` are left untouched (those are owned by the
 * paste path). A no-op patch (empty object) is a no-op write.
 */
export async function updateCitation(
  citationId: string,
  patch: { title?: string; authors?: string; year?: number; doi?: string; url?: string },
): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const update: TablesUpdate<'cb_citations'> = {};
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.authors !== undefined) update.authors = patch.authors;
  if (patch.year !== undefined) update.year = patch.year;
  if (patch.doi !== undefined) update.doi = patch.doi;
  if (patch.url !== undefined) update.url = patch.url;
  if (Object.keys(update).length === 0) return;

  const { error } = await cbFrom('cb_citations').update(update).eq('id', citationId);
  if (error) throw new Error(`updateCitation failed: ${error.message}`);
}

/** Delete a citation. Cascades remove its `cb_code_citations` link rows. */
export async function deleteCitation(citationId: string): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const { error } = await cbFrom('cb_citations').delete().eq('id', citationId);
  if (error) throw new Error(`deleteCitation failed: ${error.message}`);
}

/**
 * Link a citation to a code with a role. Idempotent on the PK
 * `(code_id, citation_id)`: re-linking the same pair upserts (updates `role`)
 * rather than failing on a duplicate-key violation, so the UI can call it
 * freely. To change the role of an existing link, call again with the new role.
 */
export async function linkCitation(
  codeId: string,
  citationId: string,
  role: CitationRole = 'derived_from',
): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const { error } = await cbFrom('cb_code_citations').upsert(
    { code_id: codeId, citation_id: citationId, role },
    { onConflict: 'code_id,citation_id' },
  );
  if (error) throw new Error(`linkCitation failed: ${error.message}`);
}

/** Remove a citation<->code link. Idempotent (deleting a missing row is fine). */
export async function unlinkCitation(codeId: string, citationId: string): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const { error } = await cbFrom('cb_code_citations')
    .delete()
    .eq('code_id', codeId)
    .eq('citation_id', citationId);
  if (error) throw new Error(`unlinkCitation failed: ${error.message}`);
}

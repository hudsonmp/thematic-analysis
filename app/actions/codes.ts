'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { linkCitation } from '@/app/actions/citations';
import { resolveRows, type CodebookRow } from '@/lib/codebook/mnemonic';
import type { RowFacetWrites } from '@/lib/codebook/grid';
import { CodeVersionInput, type CodeVersionInputT } from '@/lib/types/contracts';
import type { Json, Tables, TablesInsert } from '@/lib/types/cb-db';

type Code = Tables<'cb_codes'>;
type CodeVersion = Tables<'cb_code_versions'>;

export type CodeOrigin = 'a_priori' | 'pilot' | 'emergent';
export type CodeStatus = 'proposed' | 'active' | 'merged' | 'retired';

/**
 * Map a validated `CodeVersionInput` to the `cb_code_versions` insert payload
 * for a given code + version number. `created_by` is the researcher identity;
 * it is not populated here today, so this defaults to null and is filled in by
 * the UI/session when that lands.
 */
function versionInsert(
  codeId: string,
  version: number,
  input: CodeVersionInputT,
  createdBy: string | null,
): TablesInsert<'cb_code_versions'> {
  return {
    code_id: codeId,
    version,
    definition: input.definition,
    include_if: input.include_if as Json,
    exclude_if: input.exclude_if as Json,
    exemplars: input.exemplars as unknown as Json,
    disconfirming_pattern: input.disconfirming_pattern ?? null,
    prediction: input.prediction ?? null,
    prediction_falsifier: input.prediction_falsifier ?? null,
    change_note: input.change_note ?? null,
    created_by: createdBy,
  };
}

/**
 * Create a new code with its first version (version 1).
 *
 * Steps (no DB transaction available over PostgREST, so done in sequence):
 *   1. validate `version` with CodeVersionInput.parse (throws on bad input);
 *   2. insert cb_codes (status 'proposed');
 *   3. insert cb_code_versions (version 1);
 *   4. update cb_codes.current_version_id to the new version row id.
 *
 * `created_by` is left null for now (see versionInsert note); the real UI will
 * thread the researcher identity through once the session carries one.
 *
 * `studyLabel` (optional) tags the code with the authoring study (the per-code
 * study attribution; `cb_codes.study_label`). It is trimmed and stored, or NULL
 * when blank/absent — so existing callers that omit it are unaffected.
 *
 * Returns the new code id.
 */
export async function createCode({
  codebookId,
  mnemonic,
  name,
  origin,
  version,
  studyLabel,
}: {
  codebookId: string;
  mnemonic: string;
  name: string;
  origin: CodeOrigin;
  version: CodeVersionInputT;
  studyLabel?: string | null;
}): Promise<string> {
  const parsed = CodeVersionInput.parse(version);

  const codeRes = await cbFrom('cb_codes')
    .insert({
      codebook_id: codebookId,
      mnemonic,
      name,
      origin,
      status: 'proposed',
      study_label: studyLabel?.trim() || null,
    })
    .select('*')
    .single();
  if (codeRes.error || !codeRes.data) {
    throw new Error(`createCode (cb_codes) failed: ${codeRes.error?.message ?? 'no row returned'}`);
  }
  const code: Code = codeRes.data;

  const versionRes = await cbFrom('cb_code_versions')
    .insert(versionInsert(code.id, 1, parsed, null))
    .select('*')
    .single();
  if (versionRes.error || !versionRes.data) {
    throw new Error(
      `createCode (cb_code_versions) failed: ${versionRes.error?.message ?? 'no row returned'}`,
    );
  }

  const updateRes = await cbFrom('cb_codes')
    .update({ current_version_id: versionRes.data.id })
    .eq('id', code.id);
  if (updateRes.error) {
    throw new Error(`createCode (set current_version_id) failed: ${updateRes.error.message}`);
  }

  return code.id;
}

/**
 * Append a new version to an existing code. Computes the next version number as
 * (max existing version for this code) + 1, inserts it, and repoints
 * `current_version_id`. Returns the new version row.
 */
export async function saveNewVersion(
  codeId: string,
  version: CodeVersionInputT,
): Promise<CodeVersion> {
  const parsed = CodeVersionInput.parse(version);

  const maxRes = await cbFrom('cb_code_versions')
    .select('version')
    .eq('code_id', codeId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxRes.error) {
    throw new Error(`saveNewVersion (max version) failed: ${maxRes.error.message}`);
  }
  const nextVersion = (maxRes.data?.version ?? 0) + 1;

  const versionRes = await cbFrom('cb_code_versions')
    .insert(versionInsert(codeId, nextVersion, parsed, null))
    .select('*')
    .single();
  if (versionRes.error || !versionRes.data) {
    throw new Error(
      `saveNewVersion (insert) failed: ${versionRes.error?.message ?? 'no row returned'}`,
    );
  }

  const updateRes = await cbFrom('cb_codes')
    .update({ current_version_id: versionRes.data.id })
    .eq('id', codeId);
  if (updateRes.error) {
    throw new Error(`saveNewVersion (set current_version_id) failed: ${updateRes.error.message}`);
  }

  return versionRes.data;
}

/**
 * All versions of a code, newest first (version desc). The code page uses this
 * for the version-history list; the "current" version is whichever row the
 * code's `current_version_id` points at (highest `version` after a normal
 * save sequence, but we order by `version` explicitly rather than assume).
 */
export async function listCodeVersions(codeId: string): Promise<CodeVersion[]> {
  const res = await cbFrom('cb_code_versions')
    .select('*')
    .eq('code_id', codeId)
    .order('version', { ascending: false });
  if (res.error) {
    throw new Error(`listCodeVersions failed: ${res.error.message}`);
  }
  return res.data ?? [];
}

/** Set a code's lifecycle status. */
export async function setCodeStatus(codeId: string, status: CodeStatus): Promise<void> {
  const { error } = await cbFrom('cb_codes').update({ status }).eq('id', codeId);
  if (error) throw new Error(`setCodeStatus failed: ${error.message}`);
}

/** Retire a code: status='retired', stamp retired_at. */
export async function retireCode(codeId: string): Promise<void> {
  const { error } = await cbFrom('cb_codes')
    .update({ status: 'retired', retired_at: new Date().toISOString() })
    .eq('id', codeId);
  if (error) throw new Error(`retireCode failed: ${error.message}`);
}

/**
 * Replace the full set of facet-value tags on a code: delete all existing
 * cb_code_facet_values rows for the code, then insert the new set. A no-op set
 * (empty array) just clears the tags.
 */
export async function setCodeFacetValues(codeId: string, facetValueIds: string[]): Promise<void> {
  const del = await cbFrom('cb_code_facet_values').delete().eq('code_id', codeId);
  if (del.error) {
    throw new Error(`setCodeFacetValues (delete) failed: ${del.error.message}`);
  }
  // De-dupe to avoid PK collisions on (code_id, facet_value_id).
  const uniqueIds = [...new Set(facetValueIds)];
  if (uniqueIds.length === 0) return;
  const ins = await cbFrom('cb_code_facet_values').insert(
    uniqueIds.map((facet_value_id) => ({ code_id: codeId, facet_value_id })),
  );
  if (ins.error) {
    throw new Error(`setCodeFacetValues (insert) failed: ${ins.error.message}`);
  }
}

/**
 * Set (or clear) a code's per-facet FIELD value for a valueless facet type
 * (boolean / open_text), stored in cb_code_facet_fields keyed on
 * (code_id, facet_id). This is the analogue of `setCodeFacetValues` for the
 * NON-enum facet kinds (migration 22):
 *   - boolean   → `bool_value` (true / false)
 *   - open_text → `text_value` (a free-text note)
 *
 * Semantics: a row exists iff the code carries a value on that facet. Clearing
 * the field — `bool_value: null` for a boolean (back to "unset"), or an empty /
 * whitespace-only / null `text_value` for open_text — DELETES the row rather than
 * persisting a null-bearing row, so "no row" is the single canonical "unset".
 * Otherwise we upsert the (code_id, facet_id) row with the new value.
 *
 * Only one of `bool_value` / `text_value` is meaningful per facet (its type
 * decides which); the caller passes the field for the facet's type. A call that
 * passes neither is treated as a clear.
 */
export async function setCodeFacetField(
  codeId: string,
  facetId: string,
  { bool_value, text_value }: { bool_value?: boolean | null; text_value?: string | null },
): Promise<void> {
  const trimmedText =
    text_value === undefined || text_value === null ? null : text_value.trim() || null;
  const boolGiven = bool_value !== undefined && bool_value !== null;
  const isClear = !boolGiven && trimmedText === null;

  if (isClear) {
    const del = await cbFrom('cb_code_facet_fields')
      .delete()
      .eq('code_id', codeId)
      .eq('facet_id', facetId);
    if (del.error) {
      throw new Error(`setCodeFacetField (clear) failed: ${del.error.message}`);
    }
    return;
  }

  const { error } = await cbFrom('cb_code_facet_fields').upsert(
    {
      code_id: codeId,
      facet_id: facetId,
      bool_value: boolGiven ? bool_value! : null,
      text_value: trimmedText,
    },
    { onConflict: 'code_id,facet_id' },
  );
  if (error) {
    throw new Error(`setCodeFacetField (upsert) failed: ${error.message}`);
  }
}

/** Set (or clear, with null) a code's parent in the code hierarchy. */
export async function setCodeParent(codeId: string, parentCodeId: string | null): Promise<void> {
  const { error } = await cbFrom('cb_codes')
    .update({ parent_code_id: parentCodeId })
    .eq('id', codeId);
  if (error) throw new Error(`setCodeParent failed: ${error.message}`);
}

/**
 * Replace the full set of episode tags on a code (Feature #10): delete every
 * existing cb_code_episodes row for the code, then insert the new set. A no-op
 * set (empty array) just clears the tags. Mirrors `setCodeFacetValues` exactly —
 * the junction is a (code_id, episode_id) PK, so we de-dupe to avoid a
 * self-colliding insert. `episodeIds` are the codebook's PRESET episodes
 * (cb_episodes) the code pertains to; they are codebook-scoped, not per-session.
 */
export async function setCodeEpisodes(codeId: string, episodeIds: string[]): Promise<void> {
  const del = await cbFrom('cb_code_episodes').delete().eq('code_id', codeId);
  if (del.error) {
    throw new Error(`setCodeEpisodes (delete) failed: ${del.error.message}`);
  }
  const uniqueIds = [...new Set(episodeIds)];
  if (uniqueIds.length === 0) return;
  const ins = await cbFrom('cb_code_episodes').insert(
    uniqueIds.map((episode_id) => ({ code_id: codeId, episode_id })),
  );
  if (ins.error) {
    throw new Error(`setCodeEpisodes (insert) failed: ${ins.error.message}`);
  }
}

/** The result of a bulk create: how many rows were created, and which input rows
 *  failed (by their 0-based index in the submitted batch, with a message). The
 *  Codebook grid keeps the failed rows so the researcher can fix + retry them. */
export type BulkCreateResult = {
  created: number;
  errors: { index: number; message: string }[];
};

/**
 * Bulk-create codes from the Codebook spreadsheet grid.
 *
 * Each row is `{ name, mnemonic?, definition? }`; only `name` is required.
 * `origin` (the session "mode") applies to EVERY code in the batch; an optional
 * `citationId` links every created code `derived_from` that paper (the same
 * binding the deductive `/?fromCitation` flow uses, applied to a whole batch).
 *
 * Mnemonic handling: `cb_codes.mnemonic` is NOT NULL + UNIQUE(codebook_id,
 * mnemonic), so a blank mnemonic is synthesized from the name (slugified + made
 * unique against the codebook's existing mnemonics and the rest of this batch).
 * `resolveRows` (pure, unit-tested) does that validation/derivation up front,
 * so each create gets a non-empty, batch-unique mnemonic; a row with content but
 * no name, or an explicit mnemonic that duplicates an existing/earlier one, is
 * returned as an error and NOT created.
 *
 * Creation reuses the single-row `createCode` path (no duplicated version logic)
 * and runs sequentially so a partial failure reports the exact failing row index
 * (and the already-created rows persist). A blank definition cell falls back to
 * the code NAME: both `cb_code_versions.definition` (DB) and `CodeVersionInput`
 * (Zod `.min(1)`) require a non-empty definition, so a meaningful non-empty
 * stand-in is needed; the name is the natural one (and is overwritten the moment
 * the researcher edits the code's anatomy). Where a definition IS provided it is
 * stored verbatim, exactly like the one-line form.
 */
export async function createCodesBulk(
  codebookId: string,
  rows: CodebookRow[],
  origin: CodeOrigin,
  citationId?: string,
): Promise<BulkCreateResult> {
  if (!codebookId) throw new Error('createCodesBulk: missing codebook id.');

  const existing = await listCodebookMnemonics(codebookId);
  const { resolved, errors } = resolveRows(rows, existing);

  let created = 0;
  for (const row of resolved) {
    try {
      const newId = await createCode({
        codebookId,
        mnemonic: row.mnemonic,
        name: row.name,
        origin,
        version: {
          // Blank definition → fall back to the name (DB + Zod both require a
          // non-empty definition; the name is a meaningful stand-in).
          definition: row.definition || row.name,
          include_if: [],
          exclude_if: [],
          exemplars: [],
        },
      });
      if (citationId) {
        await linkCitation(newId, citationId, 'derived_from');
      }
      created += 1;
    } catch (err) {
      errors.push({
        index: row.index,
        message: err instanceof Error ? err.message : 'Failed to create code.',
      });
    }
  }

  return { created, errors };
}

/**
 * Bulk-create codes WITH their facet classifications, from the scheme-derived
 * Codebook spreadsheet grid.
 *
 * Same core path as `createCodesBulk` (origin applies to the batch; optional
 * `citationId` links every code `derived_from`; blank mnemonics synthesized;
 * blank definition falls back to the name). The ADDITION is per-row facet writes:
 * `facetWritesByIndex` is keyed by the row's ORIGINAL 0-based input index (the
 * same index `resolveRows` preserves through dropped empties) and carries, per
 * row:
 *   - `enumValueIds` → cb_code_facet_values for the new code (via
 *     `setCodeFacetValues`, the replace-the-set enum value setter); empty = no
 *     enum tags;
 *   - `fields`       → cb_code_facet_fields, one `setCodeFacetField` call per
 *     boolean / open_text facet the row sets (unset cells are absent).
 *
 * Per-row transactional-ish: the code + version + citation link + every facet
 * write for ONE row run in sequence; if ANY step for that row throws, the row is
 * reported as an error (kept in the grid for retry) and the loop moves on. There
 * is no PostgREST multi-statement transaction, so a row that fails AFTER the code
 * insert can leave a code with partial facets — acceptable here because the code
 * stays fully editable on its anatomy page, and the row is surfaced (not lost).
 * The pure `rowToFacetWrites` (lib/codebook/grid.ts, unit-tested) produces these
 * `RowFacetWrites` on the client; this action just applies them.
 */
export async function createCodesBulkWithFacets(
  codebookId: string,
  rows: CodebookRow[],
  facetWritesByIndex: Record<number, RowFacetWrites>,
  origin: CodeOrigin,
  citationId?: string,
): Promise<BulkCreateResult> {
  if (!codebookId) throw new Error('createCodesBulkWithFacets: missing codebook id.');

  const existing = await listCodebookMnemonics(codebookId);
  const { resolved, errors } = resolveRows(rows, existing);

  let created = 0;
  for (const row of resolved) {
    try {
      const newId = await createCode({
        codebookId,
        mnemonic: row.mnemonic,
        name: row.name,
        origin,
        version: {
          definition: row.definition || row.name,
          include_if: [],
          exclude_if: [],
          exemplars: [],
        },
      });
      if (citationId) {
        await linkCitation(newId, citationId, 'derived_from');
      }

      // Facet writes for THIS row, keyed by its original input index.
      const writes = facetWritesByIndex[row.index];
      if (writes) {
        if (writes.enumValueIds.length > 0) {
          await setCodeFacetValues(newId, writes.enumValueIds);
        }
        for (const field of writes.fields) {
          await setCodeFacetField(newId, field.facetId, {
            bool_value: field.bool_value,
            text_value: field.text_value,
          });
        }
      }

      created += 1;
    } catch (err) {
      errors.push({
        index: row.index,
        message: err instanceof Error ? err.message : 'Failed to create code.',
      });
    }
  }

  return { created, errors };
}

/** The codebook's current set of `cb_codes.mnemonic` values (case-sensitive) —
 *  the collision target for synthesized mnemonics. READ via the cb_ client. */
async function listCodebookMnemonics(codebookId: string): Promise<Set<string>> {
  const res = await cbFrom('cb_codes').select('mnemonic').eq('codebook_id', codebookId);
  if (res.error) {
    throw new Error(`listCodebookMnemonics failed: ${res.error.message}`);
  }
  return new Set((res.data ?? []).map((r) => r.mnemonic));
}

'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { linkCitation } from '@/app/actions/citations';
import { attachCodeToLabel, setCodeLabels } from '@/app/actions/labels';
import {
  resolveRows,
  uniqueMnemonic,
  writeOnlyRowErrors,
  type CodebookRow,
} from '@/lib/codebook/mnemonic';
import type { RowFacetWrites } from '@/lib/codebook/grid';
import { CodeVersionInput, type CodeVersionInputT } from '@/lib/types/contracts';
import type { Json, Tables, TablesInsert } from '@/lib/types/cb-db';
import { requireEditor } from '@/lib/auth/roles';
import { createUserServerClient } from '@/lib/supabase/user-server';

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
  origin,
  version,
  studyLabel,
  autoUniqueMnemonic = false,
}: {
  codebookId: string;
  mnemonic: string;
  origin: CodeOrigin;
  version: CodeVersionInputT;
  studyLabel?: string | null;
  /** Re-uniquify `mnemonic` against the LIVE codebook before inserting. For callers
   *  whose mnemonic was derived from a client-side SNAPSHOT of the codes list (the
   *  coding popup): another coder can mint the same mnemonic between render and
   *  submit, and UNIQUE(codebook_id, mnemonic) would reject the insert. Off by
   *  default — bulk entry treats an explicit duplicate as an ERROR to surface, and
   *  silently mangling a hand-typed mnemonic would hide that. */
  autoUniqueMnemonic?: boolean;
}): Promise<string> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const parsed = CodeVersionInput.parse(version);

  if (autoUniqueMnemonic) {
    const used = await cbFrom('cb_codes')
      .select('mnemonic')
      .eq('codebook_id', codebookId);
    if (used.error) {
      throw new Error(`createCode (mnemonics) failed: ${used.error.message}`);
    }
    mnemonic = uniqueMnemonic(mnemonic, new Set((used.data ?? []).map((r) => r.mnemonic)));
  }

  const codeRes = await cbFrom('cb_codes')
    .insert({
      codebook_id: codebookId,
      mnemonic,
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
 * Create a code FROM THE TREE — the New Code dialog behind the `+` on a node.
 *
 * Three things that were separate calls, made one, because they are one act:
 *
 *  1. the CODE + its first version (the scheme: anatomy + facets, `createCode`);
 *  2. its PLACEMENT at `labelId` — the node whose `+` was clicked. `labelId: null`
 *     means the code is authored UNPLACED, which is the ad-hoc path: structure can
 *     be difficult to impose up front, so a code is allowed to exist before it has
 *     a home and be dragged into the tree later. Placement is ADDITIVE
 *     (`attachCodeToLabel`), never `setCodeLabels`, so it cannot clobber the other
 *     placements a duplicated code holds elsewhere.
 *  3. its CITATION link, when a paper is pinned — DEDUCTIVE mode. The point of the
 *     pin is that a codebook derived from a paper should not make the researcher
 *     re-select that paper on every single code; the pin is the standing default,
 *     and the caller passes `citationId: null` when the pin is off.
 *
 * `origin` is passed explicitly rather than inferred from the pin, because "came
 * from a paper" and "is a priori" are NOT the same claim: a code can be pinned to
 * the paper it was inspired by while still being `emergent` from pilot data. The UI
 * defaults origin to `a_priori` in deductive mode; it does not force it.
 *
 * NON-ATOMIC: three PostgREST statements. A failure after step 1 leaves a real,
 * visible code that is merely unplaced or unlinked — recoverable by hand, not
 * corrupting. (Contrast with the reverse order, where a failed code insert would
 * strand a placement pointing at nothing.)
 */
export async function createCodeInTree({
  codebookId,
  mnemonic,
  origin,
  version,
  labelId,
  citationId,
  studyLabel,
}: {
  codebookId: string;
  mnemonic: string;
  origin: CodeOrigin;
  version: CodeVersionInputT;
  /** The node whose `+` was clicked. `null` = author into the Unplaced tray. */
  labelId: string | null;
  /** The pinned paper, when deductive mode is on. `null` = pin off. */
  citationId: string | null;
  studyLabel?: string | null;
}): Promise<string> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const codeId = await createCode({ codebookId, mnemonic, origin, version, studyLabel });

  if (labelId !== null) await attachCodeToLabel(codeId, labelId);
  if (citationId !== null) await linkCitation(codeId, citationId, 'derived_from');

  return codeId;
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
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
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
 * Merge N codes into one SURVIVOR — a single atomic call to the Postgres
 * function `cb_merge_codes(p_survivor, p_absorbed, p_version)`, which:
 * inserts `p_version` as the survivor's new current version; re-points the
 * absorbed codes' annotation links (deduped), citation/label/episode links
 * (unioned), coder comments, and child codes to the survivor; drops the
 * absorbed codes' facet answers; and retires them (retired_at=now(),
 * status='merged'). One statement, so unlike the sequenced actions above
 * there is no partially-merged state to recover from.
 *
 * The `version` is authored on the merge screen (survivor-anatomy draft +
 * exemplar union — lib/codebook/merge.ts) and validated here with the same
 * CodeVersionInput schema every other version write uses.
 *
 * SECURITY INVOKER: the function runs as the CALLER, so it goes through the
 * user-bound client (NOT the service role) and RLS enforces editorship at the
 * DB — requireEditor() is the matching app-level gate.
 */
export async function mergeCodes(input: {
  survivorId: string;
  absorbedIds: string[];
  version: CodeVersionInputT;
}): Promise<void> {
  await requireEditor(); // viewers are read-only; RLS also rejects them, but gate app-side like every other action
  const parsed = CodeVersionInput.parse(input.version);

  const absorbed = [...new Set(input.absorbedIds)];
  if (absorbed.length === 0) {
    throw new Error('mergeCodes: nothing to absorb — pick at least one code to merge in.');
  }
  if (absorbed.includes(input.survivorId)) {
    throw new Error('mergeCodes: the survivor cannot be in the absorbed set.');
  }

  const sb = await createUserServerClient();
  // The generated Database types carry no Functions entries (cb_merge_codes is
  // defined in a migration this app never ran typegen against), so the typed
  // client rejects the rpc name. Call through a structurally-typed view of the
  // client instead — same instance, so `this` binding and auth stay intact.
  const rpcClient = sb as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ error: { message: string } | null }>;
  };
  const { error } = await rpcClient.rpc('cb_merge_codes', {
    p_survivor: input.survivorId,
    p_absorbed: absorbed,
    p_version: parsed,
  });
  if (error) throw new Error(`mergeCodes failed: ${error.message}`);
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
/**
 * Set a code's ORIGIN. Attaching a paper post hoc flips it to `a_priori` for the same
 * reason the up-front pin does: a code you are deriving from a source IS
 * theory-derived. It stays a separate call rather than a side-effect buried inside
 * `linkCitation`, because linking a paper for PROVENANCE ("this is where I first saw
 * it") is a different act from deriving a code FROM it, and the caller is the only one
 * that knows which it meant.
 */
export async function setCodeOrigin(codeId: string, origin: CodeOrigin): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const res = await cbFrom('cb_codes').update({ origin }).eq('id', codeId);
  if (res.error) throw new Error(`setCodeOrigin failed: ${res.error.message}`);
}

export async function setCodeStatus(codeId: string, status: CodeStatus): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const { error } = await cbFrom('cb_codes').update({ status }).eq('id', codeId);
  if (error) throw new Error(`setCodeStatus failed: ${error.message}`);
}

/**
 * Hard-DELETE a code. Its versions and facet-value memberships cascade
 * (cb_code_versions / cb_code_facet_values FKs are on delete cascade).
 *
 * This is the destructive counterpart to `retireCode`, and the UI reaches it only through
 * an armed ⌘⌫ — never a bare keystroke — because it is irreversible. Retire is the right
 * move for a code that WAS coded against and should leave the working set while keeping
 * its audit trail; delete is for a capture that was a mistake and has no history worth
 * keeping. The caller chooses; this action just does the delete.
 */
export async function deleteCode(codeId: string): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const { error } = await cbFrom('cb_codes').delete().eq('id', codeId);
  if (error) throw new Error(`deleteCode failed: ${error.message}`);
}

/** Retire a code: status='retired', stamp retired_at. */
export async function retireCode(codeId: string): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
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
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
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
/**
 * Rename a code's MNEMONIC (the slug — its sole human identifier). Identity is by
 * `cb_codes.id`, so changing the slug breaks no references; it is a rename of the
 * label the researcher reads, made once they can see it next to its siblings.
 *
 * UNIQUE(codebook_id, mnemonic) is enforced by Postgres; a collision surfaces as a
 * clear error rather than being silently de-duplicated, because two codes the
 * researcher WANTED to call the same thing is a naming decision to make, not a
 * conflict to paper over.
 */
export async function renameCode(
  codeId: string,
  { mnemonic }: { mnemonic?: string },
): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const patch: { mnemonic?: string } = {};
  if (mnemonic !== undefined) {
    const trimmed = mnemonic.trim();
    if (!trimmed) throw new Error('renameCode: a mnemonic cannot be blank.');
    patch.mnemonic = trimmed;
  }
  if (Object.keys(patch).length === 0) return;

  const res = await cbFrom('cb_codes').update(patch).eq('id', codeId);
  if (res.error) throw new Error(`renameCode failed: ${res.error.message}`);
}

/**
 * ADD one facet value to a code — an ADDITIVE membership.
 *
 * Deliberately NOT `setCodeFacetValues`, which is a delete-all-then-insert of a
 * code's ENTIRE facet-value set across ALL facets. Calling that to tag one value
 * from the canvas would silently strip the code's values on every OTHER dimension —
 * catastrophic once facets are the primary mechanism and a code carries a value on
 * several of them at once.
 *
 * Idempotent: the junction PK is (code_id, facet_value_id), so re-adding is a no-op
 * rather than a duplicate-key error. On a `cardinality: 'single'` facet the CALLER
 * is responsible for clearing the previous value first — enforcing it here would
 * require reading the facet on every add, and the canvas already knows the facet.
 */
export async function addCodeFacetValue(codeId: string, facetValueId: string): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const res = await cbFrom('cb_code_facet_values').upsert(
    { code_id: codeId, facet_value_id: facetValueId },
    { onConflict: 'code_id,facet_value_id', ignoreDuplicates: true },
  );
  if (res.error) throw new Error(`addCodeFacetValue failed: ${res.error.message}`);
}

/**
 * REMOVE one facet value from a code, leaving its values on every other dimension
 * intact. Removing a code's LAST value does not delete the code — it returns to the
 * uncategorized queue, which is the whole point of letting a code exist before it has
 * been classified.
 */
export async function removeCodeFacetValue(codeId: string, facetValueId: string): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  const res = await cbFrom('cb_code_facet_values')
    .delete()
    .eq('code_id', codeId)
    .eq('facet_value_id', facetValueId);
  if (res.error) throw new Error(`removeCodeFacetValue failed: ${res.error.message}`);
}

export async function setCodeFacetField(
  codeId: string,
  facetId: string,
  { bool_value, text_value }: { bool_value?: boolean | null; text_value?: string | null },
): Promise<void> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
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
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
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
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
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
 * Each row is `{ slug, definition? }`; only `slug` is required (the slug IS the
 * mnemonic — the code's sole identifier). `origin` (the session "mode") applies
 * to EVERY code in the batch; an optional `citationId` links every created code
 * `derived_from` that paper (the same binding the deductive `/?fromCitation` flow
 * uses, applied to a whole batch).
 *
 * Mnemonic handling: `cb_codes.mnemonic` is NOT NULL + UNIQUE(codebook_id,
 * mnemonic). The typed slug is NORMALIZED (`normalizeSlug`) and that value is the
 * mnemonic. `resolveRows` (pure, unit-tested) does that validation up front; a row
 * with content but no slug, or a slug that duplicates an existing/earlier one, is
 * returned as an error and NOT created (never silently auto-suffixed).
 *
 * Creation reuses the single-row `createCode` path (no duplicated version logic)
 * and runs sequentially so a partial failure reports the exact failing row index
 * (and the already-created rows persist). A blank definition cell falls back to
 * the code's SLUG: both `cb_code_versions.definition` (DB) and `CodeVersionInput`
 * (Zod `.min(1)`) require a non-empty definition, so a meaningful non-empty
 * stand-in is needed; the slug is the natural one (and is overwritten the moment
 * the researcher edits the code's anatomy). Where a definition IS provided it is
 * stored verbatim, exactly like the one-line form.
 */
export async function createCodesBulk(
  codebookId: string,
  rows: CodebookRow[],
  origin: CodeOrigin,
  citationId?: string,
): Promise<BulkCreateResult> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  if (!codebookId) throw new Error('createCodesBulk: missing codebook id.');

  const existing = await listCodebookMnemonics(codebookId);
  const { resolved, errors } = resolveRows(rows, existing);

  let created = 0;
  for (const row of resolved) {
    try {
      const newId = await createCode({
        codebookId,
        mnemonic: row.mnemonic,
        origin,
        version: {
          // Blank definition → fall back to the slug (DB + Zod both require a
          // non-empty definition; the slug is a meaningful stand-in).
          definition: row.definition || row.mnemonic,
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
 * `citationId` links every code `derived_from`; typed slug normalized to the
 * mnemonic; blank definition falls back to the slug). The ADDITION is per-row facet writes:
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
 * write + the label tags for ONE row run in sequence; if ANY step for that row
 * throws, the row is reported as an error (kept in the grid for retry) and the
 * loop moves on. There is no PostgREST multi-statement transaction, so a row that
 * fails AFTER the code insert can leave a code with partial facets/labels —
 * acceptable here because the code stays fully editable on its anatomy page, and
 * the row is surfaced (not lost). The pure `rowToFacetWrites` /
 * `assembleLabelWrites` (lib/codebook/grid.ts, unit-tested) produce these
 * `RowFacetWrites` / label-id lists on the client; this action just applies them.
 *
 * `labelWritesByIndex` mirrors `facetWritesByIndex`: keyed by the row's ORIGINAL
 * 0-based input index, it carries the label ids the new code is tagged with (via
 * `setCodeLabels`, the replace-the-set label tagger). A row absent from the map
 * (or with an empty list) gets no `setCodeLabels` call. It defaults to `{}` so
 * existing callers that create codes without labels are unaffected.
 *
 * STATE-3 ROWS (write-bearing but slugless). A row may carry label / facet writes
 * yet have all-blank core cells. `resolveRows` (core-only emptiness) drops it
 * silently — no code, no error — so its tags would be lost with no feedback on the
 * client's success reset. We cross-reference the write-bearing indices against
 * `resolveRows`'s resolved + errored sets and append a "slug is required" error
 * for any unaccounted write-bearing index (via `writeOnlyRowErrors`). The created
 * count excludes them (no code was made) and the client keeps the errored rows in
 * the grid for the researcher to name and resubmit — tags preserved.
 */
export async function createCodesBulkWithFacets(
  codebookId: string,
  rows: CodebookRow[],
  facetWritesByIndex: Record<number, RowFacetWrites>,
  origin: CodeOrigin,
  citationId?: string,
  labelWritesByIndex: Record<number, string[]> = {},
): Promise<BulkCreateResult> {
  await requireEditor(); // viewers are read-only; service-role writes bypass RLS, so gate here
  if (!codebookId) throw new Error('createCodesBulkWithFacets: missing codebook id.');

  const existing = await listCodebookMnemonics(codebookId);
  const { resolved, errors } = resolveRows(rows, existing);

  // State-3 guard: a row that carries label / facet writes but has all-blank core
  // cells is dropped SILENTLY by `resolveRows` (its `isRowEmpty` inspects only the
  // three core cells). The client submits such rows (its `isGridRowEmpty` counts
  // labels + facets), so without this they vanish on the success reset, losing the
  // researcher's tags with no feedback. Collect the indices that actually bear a
  // write — label ids present, or a facet write with at least one enum value / one
  // field — and append a "slug is required" error for any that `resolveRows`
  // neither resolved nor errored. This makes the row surface (and be kept in the
  // grid for retry) instead of being a silent no-op. (Mirrors grid.ts's promise
  // that a tagged-but-slugless row is "surfaced ... as a 'slug is required' error".)
  const writeBearingIndices = new Set<number>();
  for (const key of Object.keys(labelWritesByIndex)) {
    if ((labelWritesByIndex[Number(key)] ?? []).length > 0) writeBearingIndices.add(Number(key));
  }
  for (const key of Object.keys(facetWritesByIndex)) {
    const w = facetWritesByIndex[Number(key)];
    if (w && (w.enumValueIds.length > 0 || w.fields.length > 0)) writeBearingIndices.add(Number(key));
  }
  errors.push(...writeOnlyRowErrors(writeBearingIndices, resolved, errors));

  let created = 0;
  for (const row of resolved) {
    try {
      const newId = await createCode({
        codebookId,
        mnemonic: row.mnemonic,
        origin,
        version: {
          definition: row.definition || row.mnemonic,
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

      // Label tags for THIS row (same index key as the facet writes). An empty /
      // absent list makes no call — the code is simply created untagged.
      const labelIds = labelWritesByIndex[row.index];
      if (labelIds && labelIds.length > 0) {
        await setCodeLabels(newId, labelIds);
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

'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { CodeVersionInput, type CodeVersionInputT } from '@/lib/types/contracts';
import type { Json, Tables, TablesInsert } from '@/lib/types/cb-db';

type Code = Tables<'cb_codes'>;
type CodeVersion = Tables<'cb_code_versions'>;

export type CodeOrigin = 'a_priori' | 'pilot' | 'emergent';
export type CodeStatus = 'proposed' | 'active' | 'merged' | 'retired';

/**
 * Map a validated `CodeVersionInput` to the `cb_code_versions` insert payload
 * for a given code + version number. `created_by` is the researcher identity;
 * the researcher session (iron-session) carries no per-user id today, so this
 * defaults to null and is populated by the UI/session when that lands.
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
 * Returns the new code id.
 */
export async function createCode({
  codebookId,
  mnemonic,
  name,
  origin,
  version,
}: {
  codebookId: string;
  mnemonic: string;
  name: string;
  origin: CodeOrigin;
  version: CodeVersionInputT;
}): Promise<string> {
  const parsed = CodeVersionInput.parse(version);

  const codeRes = await cbFrom('cb_codes')
    .insert({ codebook_id: codebookId, mnemonic, name, origin, status: 'proposed' })
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

/** Set (or clear, with null) a code's parent in the code hierarchy. */
export async function setCodeParent(codeId: string, parentCodeId: string | null): Promise<void> {
  const { error } = await cbFrom('cb_codes')
    .update({ parent_code_id: parentCodeId })
    .eq('id', codeId);
  if (error) throw new Error(`setCodeParent failed: ${error.message}`);
}

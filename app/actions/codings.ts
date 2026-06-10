'use server';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { cbFrom } from '@/lib/supabase/guard';
import { RecordingRef, type RecordingRefT } from '@/lib/types/contracts';
import type { Tables } from '@/lib/types/cb-db';

type Coding = Tables<'cb_codings'>;

/**
 * A coding as the player consumes it: the raw `cb_codings` row joined to its
 * code's mnemonic/name, with the recording span lifted out of `episode_ref`.
 * `span` is `[startMs, endMs]` on the recording clock; `segment_idxs` are the
 * brushed transcript rows (may be empty if a coding predates that field).
 */
export type CodingView = {
  id: string;
  codeId: string;
  mnemonic: string;
  name: string;
  coder: string | null;
  span: [number, number];
  segment_idxs: number[];
  created_at: string;
};

/**
 * Resolve the version int that the composite FK `(code_id, code_version) →
 * cb_code_versions(code_id, version)` requires. We prefer the code's
 * `current_version_id` (the version the codebook currently presents), falling
 * back to MAX(version) for the code. Throws if the code has no versions — a
 * coding MUST anchor to a real version row (the FK is ON DELETE RESTRICT, so a
 * dangling version int would be rejected by the insert anyway).
 */
async function resolveCurrentCodeVersion(codeId: string): Promise<number> {
  const supabase = createServiceRoleClient();

  // Preferred: the version row pointed at by current_version_id.
  const codeRes = await supabase
    .from('cb_codes')
    .select('current_version_id')
    .eq('id', codeId)
    .maybeSingle();
  if (codeRes.error) {
    throw new Error(`addCoding (resolve code) failed: ${codeRes.error.message}`);
  }
  if (!codeRes.data) {
    throw new Error(`addCoding: code ${codeId} not found`);
  }

  if (codeRes.data.current_version_id) {
    const curRes = await supabase
      .from('cb_code_versions')
      .select('version')
      .eq('id', codeRes.data.current_version_id)
      .maybeSingle();
    if (curRes.error) {
      throw new Error(`addCoding (resolve current version) failed: ${curRes.error.message}`);
    }
    if (curRes.data) return curRes.data.version;
    // current_version_id dangles — fall through to MAX(version).
  }

  // Fallback: the highest version number for this code.
  const maxRes = await supabase
    .from('cb_code_versions')
    .select('version')
    .eq('code_id', codeId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxRes.error) {
    throw new Error(`addCoding (resolve max version) failed: ${maxRes.error.message}`);
  }
  if (!maxRes.data) {
    throw new Error(
      `addCoding: code ${codeId} has no versions; cannot anchor a coding (composite FK requires a real version).`,
    );
  }
  return maxRes.data.version;
}

/**
 * Write a time-anchored coding: the researcher brushed a transcript span in the
 * session player and applied a code from the codebook. `ref` is validated as a
 * `RecordingRef` (so `episode_ref` always carries a well-formed recording
 * anchor), `code_version` is resolved to the code's current version (the
 * composite FK demands a real `(code_id, version)`), and `codebook_version_id`
 * is null — these are working codings against the live codebook, not snapshots
 * taken against a frozen codebook version. Returns the inserted row.
 */
export async function addCoding({
  codeId,
  coder,
  ref,
}: {
  codeId: string;
  coder: string;
  ref: RecordingRefT;
}): Promise<Coding> {
  const parsedRef = RecordingRef.parse(ref);
  if (typeof coder !== 'string' || coder.trim() === '') {
    throw new Error('addCoding: coder is required (coder name/initials supplied by UI).');
  }

  const codeVersion = await resolveCurrentCodeVersion(codeId);

  const res = await cbFrom('cb_codings')
    .insert({
      code_id: codeId,
      code_version: codeVersion,
      codebook_version_id: null,
      coder: coder.trim(),
      episode_ref: parsedRef,
    })
    .select('*')
    .single();
  if (res.error || !res.data) {
    throw new Error(`addCoding failed: ${res.error?.message ?? 'no row returned'}`);
  }
  return res.data;
}

/**
 * List all codings anchored to a recording (`episode_ref->>'pid' = pid`), joined
 * to each code's mnemonic/name, ordered by span start so the panel reads in
 * playback order. Read-only — uses the service-role client directly; only writes
 * route through `cbFrom`.
 *
 * The span/segment_idxs are read out of the jsonb `episode_ref`. We sort in
 * memory by `span[0]` because the start lives inside the jsonb (no column to
 * `.order()` on without a generated/expression index).
 */
export async function listCodings(pid: string): Promise<CodingView[]> {
  const supabase = createServiceRoleClient();

  const res = await supabase
    .from('cb_codings')
    .select('id, code_id, coder, episode_ref, created_at, cb_codes(mnemonic, name)')
    .eq('episode_ref->>pid', pid);
  if (res.error) {
    throw new Error(`listCodings failed: ${res.error.message}`);
  }

  const rows = (res.data ?? []) as Array<{
    id: string;
    code_id: string;
    coder: string | null;
    episode_ref: unknown;
    created_at: string;
    cb_codes: { mnemonic: string; name: string } | null;
  }>;

  const views: CodingView[] = rows.map((r) => {
    const ref = (r.episode_ref ?? {}) as {
      span?: [number, number];
      segment_idxs?: number[];
    };
    const span: [number, number] = Array.isArray(ref.span)
      ? [Number(ref.span[0]) || 0, Number(ref.span[1]) || 0]
      : [0, 0];
    return {
      id: r.id,
      codeId: r.code_id,
      mnemonic: r.cb_codes?.mnemonic ?? '(deleted code)',
      name: r.cb_codes?.name ?? '',
      coder: r.coder,
      span,
      segment_idxs: Array.isArray(ref.segment_idxs) ? ref.segment_idxs : [],
      created_at: r.created_at,
    };
  });

  views.sort((a, b) => a.span[0] - b.span[0]);
  return views;
}

/** Delete a coding by id. */
export async function deleteCoding(id: string): Promise<void> {
  const { error } = await cbFrom('cb_codings').delete().eq('id', id);
  if (error) throw new Error(`deleteCoding failed: ${error.message}`);
}

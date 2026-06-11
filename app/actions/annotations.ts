'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import type { Tables } from '@/lib/types/cb-db';

type Annotation = Tables<'cb_annotations'>;

/**
 * An annotation as the player's own-coding rail consumes it: the `cb_annotations`
 * row's display fields joined to its linked codes' `(id, mnemonic)`. `codes` is
 * the set of codes applied to this annotation (one for a `kind:'code'` anchor in
 * SP-A, but the junction is many-to-many so we return an array).
 */
export type MyAnnotationView = {
  id: string;
  segmentId: string;
  charStart: number;
  charEnd: number;
  tStartMs: number;
  tEndMs: number;
  kind: string;
  codes: { id: string; mnemonic: string }[];
  createdAt: string;
};

/**
 * Create a per-coder annotation: the signed-in researcher brushed a transcript
 * span in the session player and applied a code from the codebook.
 *
 * Runs through `createUserServerClient()` (the anon key bound to the researcher's
 * JWT), so `auth.uid()` is the signed-in user. `coder_id` is set EXPLICITLY to
 * that uid — the RLS insert policy is `with check (coder_id = auth.uid())`, so a
 * mismatched coder_id would be rejected; setting it to the caller's own uid is
 * both required (NOT NULL) and the only value RLS admits.
 *
 * Two writes, in order:
 *   1. `cb_annotations`      — the anchor row (segment_id + char range + ms span).
 *   2. `cb_annotation_codes` — one (annotation_id, code_id) link per code applied.
 *
 * On a failed code-link write we best-effort delete the annotation row (the
 * junction cascades on the annotation's delete anyway) so we never leave a
 * code-less `kind:'code'` annotation behind. Returns the inserted annotation row.
 *
 * `kind` defaults to 'code'. SP-A anchors at whole-segment granularity, so the
 * caller passes `charStart:0, charEnd:<segment.text.length>`; SP-B adds
 * sub-segment char ranges. `quote_text/prefix/suffix` are optional anchor context.
 */
export async function addAnnotation({
  sessionId,
  versionId,
  segmentId,
  charStart,
  charEnd,
  quoteText,
  prefix,
  suffix,
  tStartMs,
  tEndMs,
  kind = 'code',
  codeIds,
}: {
  sessionId: string;
  versionId: string;
  segmentId: string;
  charStart: number;
  charEnd: number;
  quoteText?: string | null;
  prefix?: string | null;
  suffix?: string | null;
  tStartMs: number;
  tEndMs: number;
  kind?: 'code' | 'quote';
  codeIds: string[];
}): Promise<Annotation> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();

  const annRes = await sb
    .from('cb_annotations')
    .insert({
      session_id: sessionId,
      version_id: versionId,
      segment_id: segmentId,
      char_start: charStart,
      char_end: charEnd,
      quote_text: quoteText ?? null,
      prefix: prefix ?? null,
      suffix: suffix ?? null,
      t_start_ms: tStartMs,
      t_end_ms: tEndMs,
      kind,
      // Set explicitly to the caller's uid: NOT NULL + RLS `with check
      // (coder_id = auth.uid())` admits only the signed-in user's own id.
      coder_id: user.id,
    })
    .select('*')
    .single();
  if (annRes.error || !annRes.data) {
    throw new Error(
      `addAnnotation: cb_annotations insert failed: ${annRes.error?.message ?? 'no row returned'}`,
    );
  }
  const annotation = annRes.data;

  // De-dupe codeIds — the junction PK is (annotation_id, code_id), so a repeated
  // code would collide. Empty set is allowed (a bare quote anchor with no code).
  const uniqueCodeIds = [...new Set(codeIds)];
  if (uniqueCodeIds.length > 0) {
    const linkRes = await sb.from('cb_annotation_codes').insert(
      uniqueCodeIds.map((code_id) => ({ annotation_id: annotation.id, code_id })),
    );
    if (linkRes.error) {
      // Unwind: drop the annotation so we never leave a code-less code anchor.
      await sb.from('cb_annotations').delete().eq('id', annotation.id);
      throw new Error(
        `addAnnotation: cb_annotation_codes insert failed: ${linkRes.error.message}`,
      );
    }
  }

  return annotation;
}

/**
 * List the signed-in coder's OWN annotations for a session (own-coding
 * isolation): `cb_annotations where session_id = ? and coder_id = auth.uid()`,
 * each joined to its `cb_annotation_codes → cb_codes(mnemonic, name)`. Ordered by
 * `t_start_ms` so the rail reads in playback order.
 *
 * The `coder_id = auth.uid()` filter is explicit AND redundant-with-RLS for
 * reads (the read policy is `using(true)`, so without this filter a coder would
 * see EVERY coder's annotations) — it is the own-coding isolation the player
 * relies on. Reads through the user client; `auth.uid()` is the signed-in user.
 */
export async function listMyAnnotations(sessionId: string): Promise<MyAnnotationView[]> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_annotations')
    .select(
      'id, segment_id, char_start, char_end, t_start_ms, t_end_ms, kind, created_at, cb_annotation_codes(code_id, cb_codes(id, mnemonic, name))',
    )
    .eq('session_id', sessionId)
    .eq('coder_id', user.id)
    .order('t_start_ms', { ascending: true });
  if (error) {
    throw new Error(`listMyAnnotations: cb_annotations select failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    id: string;
    segment_id: string;
    char_start: number;
    char_end: number;
    t_start_ms: number;
    t_end_ms: number;
    kind: string;
    created_at: string;
    cb_annotation_codes: Array<{
      code_id: string;
      cb_codes: { id: string; mnemonic: string; name: string } | null;
    }> | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    segmentId: r.segment_id,
    charStart: r.char_start,
    charEnd: r.char_end,
    tStartMs: r.t_start_ms,
    tEndMs: r.t_end_ms,
    kind: r.kind,
    codes: (r.cb_annotation_codes ?? []).map((link) => ({
      // Prefer the joined code row's id; fall back to the junction's code_id (a
      // code deleted out from under the junction would null `cb_codes`).
      id: link.cb_codes?.id ?? link.code_id,
      mnemonic: link.cb_codes?.mnemonic ?? '(deleted code)',
    })),
    createdAt: r.created_at,
  }));
}

/**
 * Delete an annotation by id. RLS (`using (coder_id = auth.uid())`) admits only
 * the signed-in coder's OWN rows — a delete of another coder's annotation
 * matches zero rows and is a silent no-op, not an error. `cb_annotation_codes`
 * cascades on the annotation's delete.
 */
export async function deleteAnnotation(id: string): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_annotations').delete().eq('id', id);
  if (error) throw new Error(`deleteAnnotation failed: ${error.message}`);
}

/**
 * One annotation as the post-hoc Compare view consumes it (Task 11): EVERY
 * coder's annotation on a session — NOT coder-filtered, the deliberate inverse of
 * `listMyAnnotations`. The read-all RLS policy (`cb_ann_read using(true)`) admits
 * the cross-coder select; this is the only surface that reads other coders' work.
 * Read-only: Compare never writes.
 */
export type CompareAnnotationView = {
  id: string;
  coderId: string;
  coderName: string;
  segmentId: string;
  tStartMs: number;
  tEndMs: number;
  isCanonical: boolean;
  codes: { id: string; mnemonic: string }[];
};

/** A distinct coder who has annotated the session (a Compare matrix column). */
export type CompareCoder = { coderId: string; coderName: string };

/**
 * List ALL coders' annotations for a session for the Compare matrix.
 *
 * Two reads, joined in JS:
 *   1. `cb_annotations where session_id = ?` (every coder — NO coder_id filter),
 *      joined to `cb_annotation_codes → cb_codes(id, mnemonic, name)` and to the
 *      anchor segment's `cb_segments(ordinal)` so we can order by transcript
 *      position. We also pull the segment ordinal to sort by.
 *   2. `cb_profiles(user_id, display_name)` for the distinct coder_ids. `coder_id`
 *      FK-references `auth.users`, NOT `cb_profiles`, so PostgREST cannot embed
 *      the profile in the annotation select — we fetch profiles by the distinct
 *      coder ids and join in memory. A coder with no profile row falls back to a
 *      short slice of their uid so the column still has a stable label.
 *
 * Ordered by segment ordinal, then coderName, then created_at — the matrix reads
 * top-to-bottom in transcript order with coders grouped stably. Returns the rows
 * plus the distinct `coders` list (the matrix's columns).
 */
export async function listAllAnnotations(
  sessionId: string,
): Promise<{ annotations: CompareAnnotationView[]; coders: CompareCoder[] }> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_annotations')
    .select(
      'id, coder_id, segment_id, t_start_ms, t_end_ms, is_canonical, created_at, cb_segments(ordinal), cb_annotation_codes(code_id, cb_codes(id, mnemonic, name))',
    )
    .eq('session_id', sessionId);
  if (error) {
    throw new Error(`listAllAnnotations: cb_annotations select failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    id: string;
    coder_id: string;
    segment_id: string;
    t_start_ms: number;
    t_end_ms: number;
    is_canonical: boolean;
    created_at: string;
    cb_segments: { ordinal: number } | null;
    cb_annotation_codes: Array<{
      code_id: string;
      cb_codes: { id: string; mnemonic: string; name: string } | null;
    }> | null;
  }>;

  // Resolve display names for the distinct coder ids. Separate read because
  // coder_id references auth.users (no PostgREST embed to cb_profiles).
  const coderIds = [...new Set(rows.map((r) => r.coder_id))];
  const nameById = new Map<string, string>();
  if (coderIds.length > 0) {
    const { data: profiles, error: profErr } = await sb
      .from('cb_profiles')
      .select('user_id, display_name')
      .in('user_id', coderIds);
    if (profErr) {
      throw new Error(`listAllAnnotations: cb_profiles select failed: ${profErr.message}`);
    }
    for (const p of profiles ?? []) {
      if (p.display_name) nameById.set(p.user_id, p.display_name);
    }
  }
  // Fallback label for a coder with no profile row (or a null display_name):
  // a short uid slice keeps the column stably identified.
  const nameFor = (coderId: string) =>
    nameById.get(coderId) ?? `coder-${coderId.slice(0, 8)}`;

  const annotations: CompareAnnotationView[] = rows.map((r) => ({
    id: r.id,
    coderId: r.coder_id,
    coderName: nameFor(r.coder_id),
    segmentId: r.segment_id,
    tStartMs: r.t_start_ms,
    tEndMs: r.t_end_ms,
    isCanonical: r.is_canonical,
    codes: (r.cb_annotation_codes ?? []).map((link) => ({
      id: link.cb_codes?.id ?? link.code_id,
      mnemonic: link.cb_codes?.mnemonic ?? '(deleted code)',
    })),
  }));

  // Sort by segment ordinal (transcript order), then coderName, then created_at.
  // The ordinal lives on the joined segment; a missing join sorts last.
  const ordinalById = new Map<string, number>();
  for (const r of rows) {
    if (r.cb_segments) ordinalById.set(r.segment_id, r.cb_segments.ordinal);
  }
  const createdById = new Map(rows.map((r) => [r.id, r.created_at]));
  annotations.sort((a, b) => {
    const oa = ordinalById.get(a.segmentId) ?? Number.MAX_SAFE_INTEGER;
    const ob = ordinalById.get(b.segmentId) ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    if (a.coderName !== b.coderName) return a.coderName.localeCompare(b.coderName);
    return (createdById.get(a.id) ?? '').localeCompare(createdById.get(b.id) ?? '');
  });

  // Distinct coders (matrix columns), ordered by display name for a stable layout.
  const coders: CompareCoder[] = coderIds
    .map((coderId) => ({ coderId, coderName: nameFor(coderId) }))
    .sort((a, b) => a.coderName.localeCompare(b.coderName));

  return { annotations, coders };
}

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
  /** The exact selected substring (sub-segment anchoring); null for whole-segment. */
  quoteText: string | null;
  tStartMs: number;
  tEndMs: number;
  /** 'code' (a coded span) or 'quote' (a flagged paper quote, no code). */
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
 * `kind` is 'code' (a coded span) or 'quote' (a flagged paper quote with NO code,
 * so `codeIds` is empty). The char range is sub-segment (Google-Docs style): the
 * caller passes the `[charStart,charEnd)` offsets of the selected TEXT within the
 * segment, plus `quote_text` (the exact substring) and `prefix`/`suffix`
 * (≤32 chars context) for re-anchoring. When no sub-selection is made the caller
 * falls back to whole-segment (`charStart:0, charEnd:<segment.text.length>`).
 * `t_start_ms`/`t_end_ms` materialize the whole segment's time in SP-A
 * (sub-segment word-timing comes later).
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
      'id, segment_id, char_start, char_end, quote_text, t_start_ms, t_end_ms, kind, created_at, cb_annotation_codes(code_id, cb_codes(id, mnemonic, name))',
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
    quote_text: string | null;
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
    quoteText: r.quote_text,
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
 * List the signed-in coder's OWN annotations for ONE transcript version of a
 * session: `cb_annotations where session_id = ? and version_id = ? and coder_id
 * = auth.uid()`. The version filter is the original/cleaned split — annotations
 * are anchored to the version they were made on (their `char_start`/`char_end`
 * offsets index THAT version's segment text), so the player must show only the
 * active version's own annotations or highlights would mis-anchor against the
 * other version's (differently-cleaned) text. Otherwise identical to
 * `listMyAnnotations` (joins codes, orders by playback time).
 */
export async function listMyAnnotationsForVersion(
  sessionId: string,
  versionId: string,
): Promise<MyAnnotationView[]> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_annotations')
    .select(
      'id, segment_id, char_start, char_end, quote_text, t_start_ms, t_end_ms, kind, created_at, cb_annotation_codes(code_id, cb_codes(id, mnemonic, name))',
    )
    .eq('session_id', sessionId)
    .eq('version_id', versionId)
    .eq('coder_id', user.id)
    .order('t_start_ms', { ascending: true });
  if (error) {
    throw new Error(
      `listMyAnnotationsForVersion: cb_annotations select failed: ${error.message}`,
    );
  }

  const rows = (data ?? []) as Array<{
    id: string;
    segment_id: string;
    char_start: number;
    char_end: number;
    quote_text: string | null;
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
    quoteText: r.quote_text,
    tStartMs: r.t_start_ms,
    tEndMs: r.t_end_ms,
    kind: r.kind,
    codes: (r.cb_annotation_codes ?? []).map((link) => ({
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

/* ───────────────────────── negotiated canonical layer (Task 12) ───────────────────────────
 *
 * After coders code INDEPENDENTLY (own-coding view) and view the diff (Compare),
 * they RECONCILE disagreements into a CANONICAL set: the authoritative coding for
 * a segment, used for export/analysis downstream (SP-C / SP-3). A canonical entry
 * is an ordinary `cb_annotations` row distinguished only by `is_canonical = true`.
 *
 * Ownership: `is_canonical` rows are still coder-owned. The reconciler is the
 * signed-in user; their uid is the `coder_id`. The RLS write policies
 * (`coder_id = auth.uid()`) therefore admit canonical writes and own-row deletes
 * exactly as they do for normal annotations — no separate policy is needed.
 *
 * Invariant: ONE canonical annotation per segment (the reconciled decision is
 * singular). `acceptIntoCanonical` enforces this by REPLACING any existing
 * canonical row for the segment before inserting the new one.
 */

/** A canonical (reconciled) annotation as Compare consumes it. */
export type CanonicalView = {
  id: string;
  segmentId: string;
  tStartMs: number;
  tEndMs: number;
  codes: { id: string; mnemonic: string }[];
};

/**
 * Accept a reconciled coding into the session's CANONICAL set for one segment.
 *
 * Inserts a `cb_annotations` row with `is_canonical = true`, `kind = 'code'`,
 * `coder_id = auth.uid()` (the reconciler), the segment's span/time, and one
 * `cb_annotation_codes` link per `codeIds`. Mirrors `addAnnotation`'s write
 * order and unwind (drop the annotation if the code-link write fails) so we never
 * leave a code-less canonical anchor.
 *
 * Canonical is ONE-PER-SEGMENT: before inserting, we delete EVERY existing
 * canonical annotation for this `segment_id` (and, by cascade, its code links),
 * so a second accept for the same segment REPLACES the first. The delete is
 * scoped to canonical rows — it never touches coders' independent annotations.
 *
 * `sourceAnnotationId` is accepted for provenance/telemetry (which coder's
 * annotation was canonized); SP-A does not persist it on the canonical row
 * (no column), so it is currently advisory only. Returns the inserted row.
 *
 * Note on RLS + replace: the delete runs through the user client, so it removes
 * only canonical rows whose `coder_id = auth.uid()` (the delete policy). In the
 * normal flow the same reconciler owns the prior canonical row, so the replace is
 * total. A canonical row authored by a DIFFERENT reconciler would survive the
 * delete (RLS no-op) and could transiently violate one-per-segment; reconciliation
 * is a single-reconciler activity in SP-A, so this is acceptable (see spec).
 */
export async function acceptIntoCanonical({
  sessionId,
  versionId,
  segmentId,
  tStartMs,
  tEndMs,
  codeIds,
  sourceAnnotationId: _sourceAnnotationId,
}: {
  sessionId: string;
  versionId: string;
  segmentId: string;
  tStartMs: number;
  tEndMs: number;
  codeIds: string[];
  sourceAnnotationId?: string;
}): Promise<Annotation> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();

  // Provenance hint only in SP-A: there is no column to persist which coder's
  // annotation was canonized, so we accept the id but do not store it. Explicitly
  // consume it so it stays part of the documented signature without a lint warning.
  void _sourceAnnotationId;

  // Enforce one-canonical-per-segment: drop any prior canonical row for this
  // segment first. cb_annotation_codes cascades on the annotation delete.
  const delRes = await sb
    .from('cb_annotations')
    .delete()
    .eq('session_id', sessionId)
    .eq('segment_id', segmentId)
    .eq('is_canonical', true);
  if (delRes.error) {
    throw new Error(
      `acceptIntoCanonical: clearing prior canonical failed: ${delRes.error.message}`,
    );
  }

  const annRes = await sb
    .from('cb_annotations')
    .insert({
      session_id: sessionId,
      version_id: versionId,
      segment_id: segmentId,
      // Whole-segment anchor (SP-A granularity); canonical decisions are per-segment.
      char_start: 0,
      char_end: 0,
      t_start_ms: tStartMs,
      t_end_ms: tEndMs,
      kind: 'code',
      is_canonical: true,
      // The reconciler owns the canonical row; RLS `with check (coder_id = auth.uid())`.
      coder_id: user.id,
    })
    .select('*')
    .single();
  if (annRes.error || !annRes.data) {
    throw new Error(
      `acceptIntoCanonical: cb_annotations insert failed: ${annRes.error?.message ?? 'no row returned'}`,
    );
  }
  const annotation = annRes.data;

  const uniqueCodeIds = [...new Set(codeIds)];
  if (uniqueCodeIds.length > 0) {
    const linkRes = await sb.from('cb_annotation_codes').insert(
      uniqueCodeIds.map((code_id) => ({ annotation_id: annotation.id, code_id })),
    );
    if (linkRes.error) {
      // Unwind: drop the canonical anchor so we never leave a code-less canonical row.
      await sb.from('cb_annotations').delete().eq('id', annotation.id);
      throw new Error(
        `acceptIntoCanonical: cb_annotation_codes insert failed: ${linkRes.error.message}`,
      );
    }
  }

  return annotation;
}

/**
 * List the session's CANONICAL (reconciled) annotations:
 * `cb_annotations where session_id = ? and is_canonical = true`, each joined to
 * its `cb_annotation_codes → cb_codes(id, mnemonic)`. One row per segment by the
 * `acceptIntoCanonical` invariant. Ordered by `t_start_ms` (playback order).
 *
 * Reads through the user client; the read-all RLS policy admits the select.
 */
export async function listCanonical(sessionId: string): Promise<CanonicalView[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_annotations')
    .select(
      'id, segment_id, t_start_ms, t_end_ms, cb_annotation_codes(code_id, cb_codes(id, mnemonic))',
    )
    .eq('session_id', sessionId)
    .eq('is_canonical', true)
    .order('t_start_ms', { ascending: true });
  if (error) {
    throw new Error(`listCanonical: cb_annotations select failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    id: string;
    segment_id: string;
    t_start_ms: number;
    t_end_ms: number;
    cb_annotation_codes: Array<{
      code_id: string;
      cb_codes: { id: string; mnemonic: string } | null;
    }> | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    segmentId: r.segment_id,
    tStartMs: r.t_start_ms,
    tEndMs: r.t_end_ms,
    codes: (r.cb_annotation_codes ?? []).map((link) => ({
      id: link.cb_codes?.id ?? link.code_id,
      mnemonic: link.cb_codes?.mnemonic ?? '(deleted code)',
    })),
  }));
}

/**
 * Remove the canonical (reconciled) coding for a segment: delete the canonical
 * annotation(s) for `segment_id` on `session_id`. `cb_annotation_codes` cascades.
 *
 * Reconciliation is collaborative, but RLS restricts delete to the row's own
 * `coder_id` — so this clears the reconciler's OWN canonical row(s) for the
 * segment. A canonical row authored by another reconciler is a silent no-op
 * (RLS), which is acceptable in SP-A's single-reconciler model.
 */
export async function removeCanonical(
  segmentId: string,
  sessionId: string,
): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_annotations')
    .delete()
    .eq('session_id', sessionId)
    .eq('segment_id', segmentId)
    .eq('is_canonical', true);
  if (error) throw new Error(`removeCanonical failed: ${error.message}`);
}

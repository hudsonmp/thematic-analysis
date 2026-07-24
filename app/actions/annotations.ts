'use server';

import { after } from 'next/server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { requireEditor } from '@/lib/auth/roles';
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
  /** The END segment for a multi-CUE annotation; null for single-segment. */
  endSegmentId: string | null;
  charStart: number;
  charEnd: number;
  /** The exact selected substring (sub-segment anchoring); null for whole-segment. */
  quoteText: string | null;
  tStartMs: number;
  tEndMs: number;
  /** 'code' (a coded span) or 'quote' (a flagged paper quote, no code). */
  kind: string;
  codes: { id: string; mnemonic: string }[];
  /** How many comments are threaded on this annotation (#17/#18 indicator). */
  commentCount: number;
  createdAt: string;
};

/**
 * One comment in an annotation's thread, as the player renders it: the
 * `cb_annotation_comments` row plus the author's display name (joined from
 * `cb_profiles`). `author_id` references `auth.users`, not `cb_profiles`, so the
 * name is resolved by a separate profiles read (see `listAnnotationComments`).
 */
export type AnnotationCommentView = {
  id: string;
  annotationId: string;
  authorId: string;
  authorName: string;
  body: string;
  resolved: boolean;
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
  endSegmentId,
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
  /** The START segment (where `charStart` indexes). */
  segmentId: string;
  /** The END segment for a multi-CUE selection (where `charEnd` indexes). Omit /
   *  null for a single-segment selection (`charEnd` then indexes `segmentId`). */
  endSegmentId?: string | null;
  charStart: number;
  charEnd: number;
  quoteText?: string | null;
  prefix?: string | null;
  suffix?: string | null;
  tStartMs: number;
  tEndMs: number;
  kind?: 'code' | 'quote' | 'bookmark';
  codeIds: string[];
}): Promise<Annotation> {
  const user = await requireAuthUser();
  // An annotation carrying CODES is a coding act → editor-only. A bare anchor (a
  // comment/quote with no codes) is open to any authed user, so viewers can comment
  // on their own selections. Without this, a viewer coding attempt hit the RLS
  // editor policy on cb_annotation_codes and surfaced as a raw 500 instead of a
  // clean permission error.
  if (codeIds.length > 0) await requireEditor();
  const sb = await createUserServerClient();

  const annRes = await sb
    .from('cb_annotations')
    .insert({
      session_id: sessionId,
      version_id: versionId,
      segment_id: segmentId,
      // NULL for single-segment (and we normalize a self-referential end to null
      // so the render path takes the simple single-cue branch).
      end_segment_id: endSegmentId && endSegmentId !== segmentId ? endSegmentId : null,
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
    // The coded span becomes an exemplar of each assigned code (deduped; non-fatal).
    // Off the response path (next/server after): exemplar accumulation is 2 +
    // 2·|codes| sequential queries of derived convenience data — blocking the
    // assign on it made every popup interaction feel seconds heavy.
    after(() => appendSpanExemplars(sb, uniqueCodeIds, quoteText, sessionId));
  }

  return annotation;
}

/**
 * List the signed-in coder's OWN annotations for a session (own-coding
 * isolation): `cb_annotations where session_id = ? and coder_id = auth.uid()`,
 * each joined to its `cb_annotation_codes → cb_codes(mnemonic)`. Ordered by
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
      'id, segment_id, end_segment_id, char_start, char_end, quote_text, t_start_ms, t_end_ms, kind, created_at, cb_annotation_codes(code_id, cb_codes(id, mnemonic)), cb_annotation_comments(id)',
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
    end_segment_id: string | null;
    char_start: number;
    char_end: number;
    quote_text: string | null;
    t_start_ms: number;
    t_end_ms: number;
    kind: string;
    created_at: string;
    cb_annotation_codes: Array<{
      code_id: string;
      cb_codes: { id: string; mnemonic: string } | null;
    }> | null;
    cb_annotation_comments: Array<{ id: string }> | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    segmentId: r.segment_id,
    endSegmentId: r.end_segment_id,
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
    // Embedded comment rows counted client-side (read-all RLS admits the embed;
    // the player only needs the count to render a thread indicator on the mark).
    commentCount: (r.cb_annotation_comments ?? []).length,
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
      'id, segment_id, end_segment_id, char_start, char_end, quote_text, t_start_ms, t_end_ms, kind, created_at, cb_annotation_codes(code_id, cb_codes(id, mnemonic)), cb_annotation_comments(id)',
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
    end_segment_id: string | null;
    char_start: number;
    char_end: number;
    quote_text: string | null;
    t_start_ms: number;
    t_end_ms: number;
    kind: string;
    created_at: string;
    cb_annotation_codes: Array<{
      code_id: string;
      cb_codes: { id: string; mnemonic: string } | null;
    }> | null;
    cb_annotation_comments: Array<{ id: string }> | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    segmentId: r.segment_id,
    endSegmentId: r.end_segment_id,
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
    commentCount: (r.cb_annotation_comments ?? []).length,
    createdAt: r.created_at,
  }));
}

/**
 * Set an annotation's `kind` ('code' | 'quote'). The player's ⌘⇧J "mark as
 * important quote" gesture: a comment anchor (or any own annotation) is promoted
 * to a flagged paper quote without changing its char-range or codes. RLS
 * (`using (coder_id = auth.uid())`) admits only the signed-in coder's OWN row —
 * a write against another coder's annotation matches zero rows (silent no-op).
 * Returns the updated row (or throws on a DB error).
 */
export async function setAnnotationKind(
  id: string,
  kind: 'code' | 'quote',
): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_annotations')
    .update({ kind })
    .eq('id', id);
  if (error) throw new Error(`setAnnotationKind failed: ${error.message}`);
}

/**
 * ADD a code to an EXISTING annotation — the multi-code gesture: the coder keeps the
 * same selection and assigns a second (third, …) code to it, so the codes group on ONE
 * anchor instead of stacking duplicate anchors on the same span.
 *
 * ADDITIVE junction insert, never delete-all-then-insert (that would drop the codes the
 * annotation already carries). `ignoreDuplicates` on the (annotation_id, code_id) PK
 * makes a repeat assign a silent no-op — assigning the same code twice is a slip, not
 * an error.
 *
 * Ownership is transitive: the junction's RLS admits a write only when the PARENT
 * annotation belongs to auth.uid(), so a coder cannot attach codes to another coder's
 * annotation.
 */
/**
 * Append a coded span's quote to each assigned code's CURRENT version as an
 * exemplar (`{text, source_pid}`), deduped on exact text. Exemplars thus
 * accumulate from coding itself — the picker's expanded rows and its
 * search-over-exemplars stay current without hand-curation (the create-flow seeds
 * the FIRST exemplar; this keeps the invariant for every later assignment, the
 * forward twin of the one-time retroactive backfill run 2026-07-18).
 *
 * NON-FATAL by design: an exemplar is derived convenience data, so a failure here
 * must never fail the assignment that triggered it. In-place update of the current
 * version row (no version bump) — same contract as the backfill.
 */
async function appendSpanExemplars(
  sb: Awaited<ReturnType<typeof createUserServerClient>>,
  codeIds: string[],
  quoteText: string | null | undefined,
  sessionId: string,
): Promise<void> {
  const text = (quoteText ?? '').trim();
  if (text === '' || codeIds.length === 0) return;
  try {
    const { data: sess } = await sb
      .from('cb_sessions')
      .select('pid_label')
      .eq('id', sessionId)
      .maybeSingle();
    const sourcePid = sess?.pid_label ?? null;
    const { data: codes } = await sb
      .from('cb_codes')
      .select('id, current_version_id')
      .in('id', codeIds);
    for (const c of codes ?? []) {
      if (!c.current_version_id) continue;
      const { data: v } = await sb
        .from('cb_code_versions')
        .select('exemplars')
        .eq('id', c.current_version_id)
        .maybeSingle();
      if (!v) continue;
      const list = Array.isArray(v.exemplars) ? v.exemplars : [];
      const exists = list.some(
        (e) => !!e && typeof e === 'object' && (e as { text?: unknown }).text === text,
      );
      if (exists) continue;
      await sb
        .from('cb_code_versions')
        .update({
          exemplars: [...list, sourcePid ? { text, source_pid: sourcePid } : { text }],
        })
        .eq('id', c.current_version_id);
    }
  } catch {
    // Non-fatal: exemplar accumulation must never break coding.
  }
}

export async function addCodeToAnnotation(
  annotationId: string,
  codeId: string,
): Promise<'added' | 'annotation_gone'> {
  await requireAuthUser();
  // Codes are editor-only (viewers may comment, not code). Belt-and-suspenders with
  // the RLS editor policy — the user client enforces RLS, but guarding here gives a
  // clean error instead of a silent RLS no-op, and documents the invariant.
  await requireEditor();
  const id = (annotationId ?? '').trim();
  const code = (codeId ?? '').trim();
  if (!id || !code) {
    throw new Error('addCodeToAnnotation: annotationId and codeId are required.');
  }
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_annotation_codes')
    .upsert(
      { annotation_id: id, code_id: code },
      { onConflict: 'annotation_id,code_id', ignoreDuplicates: true },
    );
  if (error) {
    // The caller's annotation id may be STALE — its anchor was deleted server-side
    // (last-code removal) after the client captured the id. Probe: if the anchor is
    // genuinely gone, tell the caller so it can fall through to creating a fresh
    // annotation instead of surfacing a spurious failure. Any other error (network,
    // auth expiry) stays LOUD.
    const probe = await sb.from('cb_annotations').select('id').eq('id', id).maybeSingle();
    if (!probe.error && probe.data == null) return 'annotation_gone';
    throw new Error(`addCodeToAnnotation failed: ${error.message}`);
  }

  // Re-assert the invariant "carries codes ⇒ kind:'code'" — the exact inverse of
  // removeCodeFromAnnotation's demote. Without this, assigning onto an anchor that
  // was demoted to 'quote' (last code removed, comments kept) leaves a
  // quote-with-codes row that renders NOWHERE: the gutter draws kind:'code' only,
  // and the inline painter skips codes — the UI would claim success while the code
  // silently vanished from every surface.
  const promote = await sb
    .from('cb_annotations')
    .update({ kind: 'code' })
    .eq('id', id)
    .neq('kind', 'code');
  if (promote.error) {
    throw new Error(`addCodeToAnnotation (promote) failed: ${promote.error.message}`);
  }

  // Exemplar accumulation: the just-coded span becomes an exemplar of the code
  // (deduped; non-fatal). Runs AFTER the response (next/server after) — it needs
  // an extra anchor read plus per-code version reads/writes, and the assign
  // must not wait on derived convenience data.
  after(async () => {
    const anchor = await sb
      .from('cb_annotations')
      .select('quote_text, session_id')
      .eq('id', id)
      .maybeSingle();
    if (anchor.data) {
      await appendSpanExemplars(sb, [code], anchor.data.quote_text, anchor.data.session_id);
    }
  });
  return 'added';
}

/**
 * REMOVE one code from an annotation. JUST the junction row: the anchor (the
 * bracket in the gutter) is DURABLE — deleting its last code leaves an empty
 * bracket the coder can re-code later, because the bracket records "this span is
 * analytically interesting" independently of which codes currently name it.
 * Deleting the bracket itself is a separate, explicit act (deleteAnnotation).
 *
 * (This deliberately retires the old last-code policy — demote-to-quote / delete —
 * after live use: auto-destroying the anchor made re-coding a span cost a fresh
 * selection, and the coder owns the bracket's lifetime, not the code count.)
 */
export async function removeCodeFromAnnotation(
  annotationId: string,
  codeId: string,
): Promise<void> {
  await requireAuthUser();
  await requireEditor(); // codes are editor-only (see addCodeToAnnotation)
  const sb = await createUserServerClient();
  const del = await sb
    .from('cb_annotation_codes')
    .delete()
    .eq('annotation_id', annotationId)
    .eq('code_id', codeId);
  if (del.error) throw new Error(`removeCodeFromAnnotation failed: ${del.error.message}`);
}

/**
 * RE-ANCHOR an annotation: replace WHAT TEXT the bracket covers, keeping its codes
 * and comments. The "edit selection" affordance — a bracket whose span was slightly
 * off should be fixable by re-highlighting, not by delete-and-recode (which would
 * throw away the code set and any thread). RLS `using (coder_id = auth.uid())`
 * scopes the update to the caller's own annotation; another coder's id is a silent
 * zero-row no-op.
 */
export async function updateAnnotationAnchor(
  annotationId: string,
  anchor: {
    segmentId: string;
    endSegmentId?: string | null;
    charStart: number;
    charEnd: number;
    quoteText?: string | null;
    prefix?: string | null;
    suffix?: string | null;
    tStartMs: number;
    tEndMs: number;
  },
): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_annotations')
    .update({
      segment_id: anchor.segmentId,
      end_segment_id:
        anchor.endSegmentId && anchor.endSegmentId !== anchor.segmentId
          ? anchor.endSegmentId
          : null,
      char_start: anchor.charStart,
      char_end: anchor.charEnd,
      quote_text: anchor.quoteText ?? null,
      prefix: anchor.prefix ?? null,
      suffix: anchor.suffix ?? null,
      t_start_ms: anchor.tStartMs,
      t_end_ms: anchor.tEndMs,
      anchor_status: 'exact',
    })
    .eq('id', annotationId);
  if (error) throw new Error(`updateAnnotationAnchor failed: ${error.message}`);
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
 *      joined to `cb_annotation_codes → cb_codes(id, mnemonic)` and to the
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
      // cb_annotations carries TWO FKs to cb_segments (segment_id + the multi-cue
      // end_segment_id), so the embed MUST name its relationship — the bare
      // cb_segments(ordinal) form 500s with 'more than one relationship found'
      // (this silently broke /compare when multi-cue anchors landed).
      'id, coder_id, segment_id, t_start_ms, t_end_ms, is_canonical, created_at, cb_segments!cb_annotations_segment_id_fkey(ordinal), cb_annotation_codes(code_id, cb_codes(id, mnemonic))',
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
      cb_codes: { id: string; mnemonic: string } | null;
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

/* ───────────────────── per-excerpt comments (#17/#18) ─────────────────────────
 *
 * Google-Docs-style commenting: a comment is anchored to ONE annotation — a
 * coder's highlighted transcript excerpt (`cb_annotations`, char-anchored). The
 * player opens a comment thread when a highlight `<mark>` is clicked. Commenting
 * on arbitrary not-yet-coded text is a two-step compose in the player: create a
 * `kind:'quote'` annotation (the anchor, via `addAnnotation`) then the first
 * comment on it (via `addAnnotationComment`).
 *
 * Ownership mirrors annotations' read-all / write-own asymmetry, keyed on
 * `author_id = auth.uid()` (the `cb_annotation_comments` RLS policies):
 *   * SELECT is read-all — a comment thread is shared context, like a Docs
 *     comment everyone in the doc can see (so reconcilers see each other's notes).
 *   * INSERT/UPDATE/DELETE are own-only — a coder may only add/resolve/delete
 *     their OWN comments. `author_id` is set EXPLICITLY to the caller's uid; the
 *     `with check (author_id = auth.uid())` policy admits only that value, so a
 *     forged author_id is rejected by RLS.
 *
 * All four route through `createUserServerClient()` (the anon key bound to the
 * signed-in user's JWT), NOT `cbFrom()` — the service-role client bypasses RLS,
 * which would both defeat the own-write guarantee and leave `auth.uid()` null
 * (failing the WITH CHECK). The user client is the only client that makes these
 * policies meaningful.
 */

/**
 * Add a comment to an annotation's thread. `author_id` is the signed-in user
 * (RLS `with check (author_id = auth.uid())` admits only that). `body` must be a
 * non-empty string — an empty comment is never useful. Returns the inserted row.
 */
export async function addAnnotationComment(
  annotationId: string,
  body: string,
): Promise<Tables<'cb_annotation_comments'>> {
  const user = await requireAuthUser();
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('addAnnotationComment: body must be a non-empty string.');
  }
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_annotation_comments')
    .insert({
      annotation_id: annotationId,
      // Set explicitly to the caller's uid: RLS `with check (author_id =
      // auth.uid())` admits only the signed-in user's own id.
      author_id: user.id,
      body: body.trim(),
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(
      `addAnnotationComment failed: ${error?.message ?? 'no row returned'}`,
    );
  }
  return data;
}

/**
 * List comments for a set of annotations, grouped by annotation id, so the
 * player can load every comment for the session's visible annotations in ONE
 * call. Each comment carries its author's `display_name` (joined from
 * `cb_profiles`).
 *
 * Two reads, joined in JS — the same shape as `listAllAnnotations`:
 *   1. `cb_annotation_comments where annotation_id in (...)`, oldest-first
 *      (thread order). The read-all RLS policy admits every coder's comments.
 *   2. `cb_profiles(user_id, display_name)` for the distinct author ids.
 *      `author_id` references `auth.users`, NOT `cb_profiles`, so PostgREST
 *      cannot embed the profile in the comment select — we resolve names by the
 *      distinct author ids and join in memory. An author with no profile row
 *      falls back to a short uid slice so the comment is still attributed.
 *
 * Returns a `Record<annotationId, AnnotationCommentView[]>` (only annotations
 * with ≥1 comment appear). An empty `annotationIds` short-circuits to `{}`.
 */
export async function listAnnotationComments(
  annotationIds: string[],
): Promise<Record<string, AnnotationCommentView[]>> {
  await requireAuthUser();
  const ids = [...new Set(annotationIds)];
  if (ids.length === 0) return {};

  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_annotation_comments')
    .select('id, annotation_id, author_id, body, resolved, created_at')
    .in('annotation_id', ids)
    .order('created_at', { ascending: true });
  if (error) {
    throw new Error(`listAnnotationComments select failed: ${error.message}`);
  }

  const rows = data ?? [];

  // Resolve author display names. Separate read because author_id references
  // auth.users (no PostgREST embed to cb_profiles).
  const authorIds = [...new Set(rows.map((r) => r.author_id))];
  const nameById = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: profiles, error: profErr } = await sb
      .from('cb_profiles')
      .select('user_id, display_name')
      .in('user_id', authorIds);
    if (profErr) {
      throw new Error(
        `listAnnotationComments: cb_profiles select failed: ${profErr.message}`,
      );
    }
    for (const p of profiles ?? []) {
      if (p.display_name) nameById.set(p.user_id, p.display_name);
    }
  }
  const nameFor = (authorId: string) =>
    nameById.get(authorId) ?? `coder-${authorId.slice(0, 8)}`;

  const grouped: Record<string, AnnotationCommentView[]> = {};
  for (const r of rows) {
    const view: AnnotationCommentView = {
      id: r.id,
      annotationId: r.annotation_id,
      authorId: r.author_id,
      authorName: nameFor(r.author_id),
      body: r.body,
      resolved: r.resolved,
      createdAt: r.created_at,
    };
    (grouped[r.annotation_id] ??= []).push(view);
  }
  return grouped;
}

/**
 * Flip a comment's `resolved` flag (resolve / re-open). RLS
 * (`using (author_id = auth.uid())`) admits only the author's OWN comment — a
 * resolve of another coder's comment matches zero rows (silent no-op).
 */
export async function resolveAnnotationComment(
  id: string,
  resolved: boolean,
): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_annotation_comments')
    .update({ resolved })
    .eq('id', id);
  if (error) throw new Error(`resolveAnnotationComment failed: ${error.message}`);
}

/**
 * Edit a comment's body in place. RLS (`using (author_id = auth.uid())` +
 * `with check (author_id = auth.uid())`) admits only the author's OWN comment —
 * an edit of another coder's comment matches zero rows (silent no-op). `body`
 * must be a non-empty string; an empty edit is the caller's signal to DELETE the
 * note instead (Docs-like), which the client handles by calling
 * `deleteAnnotationComment` rather than committing an empty body here.
 */
export async function editAnnotationComment(id: string, body: string): Promise<void> {
  await requireAuthUser();
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('editAnnotationComment: body must be a non-empty string.');
  }
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_annotation_comments')
    .update({ body: body.trim() })
    .eq('id', id);
  if (error) throw new Error(`editAnnotationComment failed: ${error.message}`);
}

/**
 * Delete a comment by id. RLS (`using (author_id = auth.uid())`) admits only the
 * author's OWN comment — a delete of another coder's comment matches zero rows
 * (silent no-op, not an error). Does NOT delete the anchor annotation: a
 * commented excerpt can lose its thread and still be a coded/quoted span.
 */
export async function deleteAnnotationComment(id: string): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_annotation_comments')
    .delete()
    .eq('id', id);
  if (error) throw new Error(`deleteAnnotationComment failed: ${error.message}`);
}

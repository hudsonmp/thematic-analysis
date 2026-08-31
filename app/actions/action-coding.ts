'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { pageAll } from '@/lib/supabase/pageAll';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { requireEditor } from '@/lib/auth/roles';
import type { Json, Tables } from '@/lib/types/cb-db';
import {
  answerRows,
  cleanObjectRoles,
  compositionKey,
  compositionLabel,
  findMoveByName,
  findObjectByName,
  parentProblem,
  validateComposition,
  type ActionCodingView,
  type ActionDraft,
  type AnswerDraft,
  type CompositionAnswer,
  type ManualComposition,
} from '@/lib/actions/schema';
import { foldUsage, type ActionUsage } from '@/lib/actions/search';
import { codingDetail } from '@/lib/actions/projection';
import {
  coderStatusFromRow,
  type CoderStatus,
} from '@/lib/codebook/sessionProgress';
import {
  createAction,
  createMove,
  createObject,
  getActionSchema,
  type ActionMove,
  type ActionObject,
  type ActionSchema,
} from '@/app/actions/action-schema';
import type { AnnotationCommentView, MyAnnotationView } from '@/app/actions/annotations';

// ---------------------------------------------------------------------------
// Action-based coding (migration 48): the /coding/action layer.
//
// Same anchor grammar as the codebook layer (cb_annotations), but the thing
// attached to a span is an ACTION CODING — either a reusable cb_actions row or
// an ad hoc MOVE(s) × OBJECT(s) × answers combination. Everything lives in its
// own tables (cb_action_annotations / cb_action_codings /
// cb_action_annotation_comments / cb_action_coding_status) so the two coding
// systems cannot leak into each other by construction. Writes go through the
// JWT-bound user client; RLS enforces coder ownership exactly like the legacy
// layer.
//
// The player consumes the SAME MyAnnotationView shape: each coding is exposed
// as a "code" whose id is the CODING row id (so removal is per coding, not per
// action — two ad hoc codings on one span have no other identity), whose
// mnemonic is the display label, and which carries the full `actionCoding`
// detail for the popup/rail to render moves/objects/answers directly.
// ---------------------------------------------------------------------------

type ActionAnnotation = Tables<'cb_action_annotations'>;

function parseAnswers(raw: Json): CompositionAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: CompositionAnswer[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const o = a as { questionId?: unknown; optionId?: unknown; freeText?: unknown };
    if (typeof o.questionId !== 'string') continue;
    out.push({
      questionId: o.questionId,
      optionId: typeof o.optionId === 'string' ? o.optionId : null,
      freeText: typeof o.freeText === 'string' ? o.freeText : null,
    });
  }
  return out;
}

/** The object_roles jsonb snapshot ({objectId: roleId}) as a clean string map. */
function parseObjectRoles(raw: Json): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v;
  return out;
}

/** Resolve the codebook an action-layer coding belongs to via its session's
 *  study → the active codebook for that session is whatever /actions authors
 *  against. The player passes the codebook id explicitly, so this only needs
 *  the schema loader. */
async function schemaFor(codebookId: string): Promise<ActionSchema> {
  return getActionSchema(codebookId);
}

function toView(
  r: {
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
    cb_action_codings:
      | Array<{
          id: string;
          action_id: string | null;
          action_name: string | null;
          move_ids: string[];
          object_ids: string[];
          object_roles: Json;
          answers: Json;
          created_at: string;
          cb_actions: { id: string; name: string } | null;
        }>
      | null;
    cb_action_annotation_comments: Array<{ id: string }> | null;
  },
  schema: ActionSchema,
): MyAnnotationView {
  const codings = [...(r.cb_action_codings ?? [])].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
  const qLites = schema.questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    kind: q.kind,
    required: q.required,
    options: q.options.map((o) => ({ id: o.id, label: o.label })),
  }));
  return {
    id: r.id,
    segmentId: r.segment_id,
    endSegmentId: r.end_segment_id,
    charStart: r.char_start,
    charEnd: r.char_end,
    quoteText: r.quote_text,
    tStartMs: r.t_start_ms,
    tEndMs: r.t_end_ms,
    kind: r.kind,
    codes: codings.map((c) => {
      // A coding renders the SNAPSHOT it was stored with — never the action's
      // current composition. See lib/actions/projection.ts for why. Divergence
      // comes back as `drifted` for the UI to surface, not as a rewrite.
      const { detail, drifted } = codingDetail(
        {
          id: c.id,
          actionId: c.action_id,
          // Pre-migration-51 rows have no name snapshot; fall back to the live
          // name once, so an old coding still renders with a label.
          actionName: c.action_name ?? c.cb_actions?.name ?? null,
          moveIds: c.move_ids,
          objectIds: c.object_ids,
          objectRoles: parseObjectRoles(c.object_roles),
          answers: parseAnswers(c.answers),
        },
        schema.actions,
        qLites,
      );
      return {
        id: c.id,
        mnemonic: detail.actionName ?? compositionLabel(detail, schema),
        actionCoding: detail,
        actionDrifted: drifted,
      };
    }),
    commentCount: (r.cb_action_annotation_comments ?? []).length,
    createdAt: r.created_at,
  };
}

const ANN_SELECT =
  'id, segment_id, end_segment_id, char_start, char_end, quote_text, t_start_ms, t_end_ms, kind, created_at, cb_action_codings(id, action_id, action_name, move_ids, object_ids, object_roles, answers, created_at, cb_actions(id, name)), cb_action_annotation_comments(id)';

/**
 * The signed-in coder's OWN action-layer annotations for one transcript version
 * (own-coding isolation + version scoping, exactly like
 * listMyAnnotationsForVersion). `codebookId` resolves action names/compositions.
 */
export async function listMyActionAnnotationsForVersion(
  sessionId: string,
  versionId: string,
  codebookId: string,
): Promise<MyAnnotationView[]> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();
  const [schema, res] = await Promise.all([
    schemaFor(codebookId),
    pageAll((from, to) =>
      sb
        .from('cb_action_annotations')
        .select(ANN_SELECT)
        .eq('session_id', sessionId)
        .eq('version_id', versionId)
        .eq('coder_id', user.id)
        .order('t_start_ms', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ]);
  if (res.error) {
    throw new Error(`listMyActionAnnotationsForVersion failed: ${res.error.message}`);
  }
  return ((res.data ?? []) as unknown as Parameters<typeof toView>[0][]).map((r) => toView(r, schema));
}

/** What a coding attaches: an existing action by id, or an ad hoc composition. */
export type CodingRef = { actionId: string } | { manual: ManualComposition };

/**
 * Turn a coding ref into the row to insert. A MANUAL composition that exactly
 * matches an existing action is RESOLVED to that action (the duplicate guard,
 * using the one canonical compositionKey) — the modal does the same check
 * client-side, this is the server's belt-and-braces. Validates the composition
 * against the current vocabulary.
 */
async function codingRow(
  ref: CodingRef,
  codebookId: string,
): Promise<{ action_id: string | null; action_name: string | null; move_ids: string[]; object_ids: string[]; object_roles: Json; answers: Json }> {
  const schema = await schemaFor(codebookId);
  const qLites = schema.questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    kind: q.kind,
    required: q.required,
    options: q.options.map((o) => ({ id: o.id, label: o.label })),
  }));
  if ('actionId' in ref) {
    const a = schema.actions.find((x) => x.id === ref.actionId);
    if (!a) throw new Error('That action no longer exists.');
    return {
      action_id: a.id,
      action_name: a.name,
      move_ids: a.moveIds,
      object_ids: a.objectIds,
      object_roles: a.objectRoles,
      answers: a.answers as unknown as Json,
    };
  }
  const mLites = schema.moves.map((m) => ({ id: m.id, name: m.name, minObjects: m.minObjects }));
  const problems = validateComposition(ref.manual, mLites, qLites, schema.roles);
  if (problems.length) throw new Error(problems.join(' '));
  const answers = answerRows(ref.manual.answers as Record<string, AnswerDraft>, qLites);
  const objectIds = Array.from(new Set(ref.manual.objectIds));
  const objectRoles = cleanObjectRoles(ref.manual.objectRoles, objectIds, schema.roles);
  const composition = { moveIds: ref.manual.moveIds, objectIds, answers, objectRoles };
  const key = compositionKey(composition, qLites);
  const existing = schema.actions.find((a) => compositionKey(a, qLites) === key) ?? null;
  return {
    action_id: existing?.id ?? null,
    action_name: existing?.name ?? null,
    move_ids: Array.from(new Set(ref.manual.moveIds)),
    object_ids: objectIds,
    object_roles: objectRoles,
    answers: answers as unknown as Json,
  };
}

/**
 * Create an action-layer anchor, optionally with its first coding. Mirrors
 * addAnnotation: kind 'code' (coded span) / 'quote' / 'bookmark'; a coding is
 * a coding act → editor-only; a bare anchor is open to any authed user.
 */
export async function addActionAnnotation({
  sessionId,
  versionId,
  codebookId,
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
  coding = null,
}: {
  sessionId: string;
  versionId: string;
  codebookId: string;
  segmentId: string;
  endSegmentId?: string | null;
  charStart: number;
  charEnd: number;
  quoteText?: string | null;
  prefix?: string | null;
  suffix?: string | null;
  tStartMs: number;
  tEndMs: number;
  kind?: 'code' | 'quote' | 'bookmark';
  coding?: CodingRef | null;
}): Promise<ActionAnnotation> {
  const user = await requireAuthUser();
  if (coding) await requireEditor();
  const sb = await createUserServerClient();
  // Resolve/validate BEFORE inserting the anchor so a bad composition leaves
  // no orphan.
  const row = coding ? await codingRow(coding, codebookId) : null;

  const annRes = await sb
    .from('cb_action_annotations')
    .insert({
      session_id: sessionId,
      version_id: versionId,
      segment_id: segmentId,
      end_segment_id: endSegmentId && endSegmentId !== segmentId ? endSegmentId : null,
      char_start: charStart,
      char_end: charEnd,
      quote_text: quoteText ?? null,
      prefix: prefix ?? null,
      suffix: suffix ?? null,
      t_start_ms: tStartMs,
      t_end_ms: tEndMs,
      kind,
      coder_id: user.id,
    })
    .select('*')
    .single();
  if (annRes.error || !annRes.data) {
    throw new Error(`addActionAnnotation failed: ${annRes.error?.message ?? 'no row returned'}`);
  }
  const annotation = annRes.data;
  if (row) {
    const link = await sb.from('cb_action_codings').insert({ annotation_id: annotation.id, ...row });
    if (link.error) {
      await sb.from('cb_action_annotations').delete().eq('id', annotation.id);
      throw new Error(`addActionAnnotation (coding) failed: ${link.error.message}`);
    }
    await touchStatus(sb, sessionId, user.id);
  }
  return annotation;
}

/**
 * Attach a coding to an EXISTING anchor (the multi-coding gesture). Returns
 * 'annotation_gone' when the anchor id is stale so the caller can fall through
 * to creating a fresh one (same contract as addCodeToAnnotation). Re-asserts
 * kind:'code' so a coded bookmark/quote renders as a coded span.
 */
export async function addActionCoding(
  annotationId: string,
  ref: CodingRef,
  codebookId: string,
): Promise<'added' | 'annotation_gone'> {
  const user = await requireAuthUser();
  await requireEditor();
  const sb = await createUserServerClient();
  const probe = await sb
    .from('cb_action_annotations')
    .select('id, session_id')
    .eq('id', annotationId)
    .maybeSingle();
  if (probe.error) throw new Error(`addActionCoding failed: ${probe.error.message}`);
  if (!probe.data) return 'annotation_gone';
  const row = await codingRow(ref, codebookId);
  const ins = await sb.from('cb_action_codings').insert({ annotation_id: annotationId, ...row });
  if (ins.error) throw new Error(`addActionCoding failed: ${ins.error.message}`);
  const promote = await sb
    .from('cb_action_annotations')
    .update({ kind: 'code' })
    .eq('id', annotationId)
    .neq('kind', 'code');
  if (promote.error) throw new Error(`addActionCoding (promote) failed: ${promote.error.message}`);
  await touchStatus(sb, probe.data.session_id, user.id);
  return 'added';
}

/** Remove ONE coding (by coding row id); the anchor survives, even empty. */
export async function removeActionCoding(annotationId: string, codingId: string): Promise<void> {
  await requireAuthUser();
  await requireEditor();
  const sb = await createUserServerClient();
  const del = await sb
    .from('cb_action_codings')
    .delete()
    .eq('id', codingId)
    .eq('annotation_id', annotationId);
  if (del.error) throw new Error(`removeActionCoding failed: ${del.error.message}`);
}

/** Re-anchor an action-layer annotation (codings + comments ride along). */
export async function updateActionAnnotationAnchor(
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
    .from('cb_action_annotations')
    .update({
      segment_id: anchor.segmentId,
      end_segment_id:
        anchor.endSegmentId && anchor.endSegmentId !== anchor.segmentId ? anchor.endSegmentId : null,
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
  if (error) throw new Error(`updateActionAnnotationAnchor failed: ${error.message}`);
}

/** Delete an action-layer anchor (codings + comments cascade). Own rows only (RLS). */
export async function deleteActionAnnotation(id: string): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_action_annotations').delete().eq('id', id);
  if (error) throw new Error(`deleteActionAnnotation failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Comments (margin notes) on action-layer anchors — same contract as the
// cb_annotation_comments actions.
// ---------------------------------------------------------------------------

export async function addActionAnnotationComment(
  annotationId: string,
  body: string,
): Promise<Tables<'cb_action_annotation_comments'>> {
  const user = await requireAuthUser();
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('addActionAnnotationComment: body must be a non-empty string.');
  }
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_action_annotation_comments')
    .insert({ annotation_id: annotationId, author_id: user.id, body: body.trim() })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`addActionAnnotationComment failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

export async function listActionAnnotationComments(
  annotationIds: string[],
): Promise<Record<string, AnnotationCommentView[]>> {
  await requireAuthUser();
  const ids = [...new Set(annotationIds)];
  if (ids.length === 0) return {};
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_action_annotation_comments')
    .select('id, annotation_id, author_id, body, resolved, created_at')
    .in('annotation_id', ids)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listActionAnnotationComments failed: ${error.message}`);
  const rows = data ?? [];
  const authorIds = [...new Set(rows.map((r) => r.author_id))];
  const nameById = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: profiles, error: profErr } = await sb
      .from('cb_profiles')
      .select('user_id, display_name')
      .in('user_id', authorIds);
    if (profErr) throw new Error(`listActionAnnotationComments (profiles) failed: ${profErr.message}`);
    for (const p of profiles ?? []) if (p.display_name) nameById.set(p.user_id, p.display_name);
  }
  const grouped: Record<string, AnnotationCommentView[]> = {};
  for (const r of rows) {
    (grouped[r.annotation_id] ??= []).push({
      id: r.id,
      annotationId: r.annotation_id,
      authorId: r.author_id,
      authorName: nameById.get(r.author_id) ?? `coder-${r.author_id.slice(0, 8)}`,
      body: r.body,
      resolved: r.resolved,
      createdAt: r.created_at,
    });
  }
  return grouped;
}

export async function editActionAnnotationComment(id: string, body: string): Promise<void> {
  await requireAuthUser();
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('editActionAnnotationComment: body must be a non-empty string.');
  }
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_action_annotation_comments')
    .update({ body: body.trim() })
    .eq('id', id);
  if (error) throw new Error(`editActionAnnotationComment failed: ${error.message}`);
}

export async function deleteActionAnnotationComment(id: string): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_action_annotation_comments').delete().eq('id', id);
  if (error) throw new Error(`deleteActionAnnotationComment failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Per-coder progress for /coding/action — independent of the legacy
// cb_session_coding_status (absent row = not_started).
// ---------------------------------------------------------------------------

/** A /coding/action index row: the session + THIS coder's action-coding status. */
export type ActionCodingSessionRow = {
  id: string;
  pidLabel: string;
  collection: string;
  durationMs: number | null;
  status: CoderStatus;
  /** How many action-layer anchors this coder has on the session (any version). */
  myAnnotationCount: number;
};

export async function listActionCodingSessions(): Promise<ActionCodingSessionRow[]> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();
  const [sessions, statuses, anns] = await Promise.all([
    sb
      .from('cb_sessions')
      .select('id, pid_label, collection, duration_ms')
      .order('collection', { ascending: true })
      .order('created_at', { ascending: true }),
    sb.from('cb_action_coding_status').select('session_id, status').eq('coder_id', user.id),
    sb.from('cb_action_annotations').select('session_id').eq('coder_id', user.id),
  ]);
  if (sessions.error) throw new Error(`listActionCodingSessions failed: ${sessions.error.message}`);
  if (statuses.error) throw new Error(`listActionCodingSessions (status) failed: ${statuses.error.message}`);
  if (anns.error) throw new Error(`listActionCodingSessions (annotations) failed: ${anns.error.message}`);
  const statusBy = new Map((statuses.data ?? []).map((r) => [r.session_id, r.status]));
  const counts = new Map<string, number>();
  for (const a of anns.data ?? []) counts.set(a.session_id, (counts.get(a.session_id) ?? 0) + 1);
  return (sessions.data ?? []).map((r) => ({
    id: r.id,
    pidLabel: r.pid_label,
    collection: r.collection,
    durationMs: r.duration_ms,
    status: coderStatusFromRow(statusBy.has(r.id) ? { status: statusBy.get(r.id)! } : null),
    myAnnotationCount: counts.get(r.id) ?? 0,
  }));
}

/**
 * How often / how recently THIS coder has applied each reusable action across
 * the OTHER sessions (the picker's "prefer recent/frequent actions" tie-break).
 * `excludeSessionId` is left out because the player already holds that
 * session's codings in state and folds them in live — counting them here too
 * would double them. Ad hoc codings (null action_id) are not usage of anything.
 */
export async function getMyActionUsage(excludeSessionId: string | null): Promise<ActionUsage> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();
  const res = await pageAll((from, to) => {
    let q = sb
      .from('cb_action_codings')
      .select('action_id, created_at, cb_action_annotations!inner(coder_id, session_id)')
      .eq('cb_action_annotations.coder_id', user.id)
      .not('action_id', 'is', null);
    if (excludeSessionId) q = q.neq('cb_action_annotations.session_id', excludeSessionId);
    return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to);
  });
  if (res.error) throw new Error(`getMyActionUsage failed: ${res.error.message}`);
  return foldUsage(
    ((res.data ?? []) as unknown as { action_id: string | null; created_at: string }[]).map((r) => ({
      actionId: r.action_id,
      createdAt: r.created_at,
    })),
  );
}

export async function setActionCoderStatus(sessionId: string, status: CoderStatus): Promise<void> {
  const user = await requireAuthUser();
  const id = (sessionId ?? '').trim();
  if (!id) throw new Error('setActionCoderStatus: sessionId is required.');
  const sb = await createUserServerClient();
  if (status === 'not_started') {
    const { error } = await sb
      .from('cb_action_coding_status')
      .delete()
      .eq('session_id', id)
      .eq('coder_id', user.id);
    if (error) throw new Error(`setActionCoderStatus: reset failed: ${error.message}`);
    return;
  }
  const { error } = await sb
    .from('cb_action_coding_status')
    .upsert(
      { session_id: id, coder_id: user.id, status, updated_at: new Date().toISOString() },
      { onConflict: 'session_id,coder_id' },
    );
  if (error) throw new Error(`setActionCoderStatus failed: ${error.message}`);
}

/** First coding on a session flips not_started → in_progress (a row appears);
 *  an existing row (in_progress / individual_coding) is left alone. Non-fatal. */
async function touchStatus(
  sb: Awaited<ReturnType<typeof createUserServerClient>>,
  sessionId: string,
  coderId: string,
): Promise<void> {
  try {
    await sb
      .from('cb_action_coding_status')
      .upsert(
        { session_id: sessionId, coder_id: coderId, status: 'in_progress' },
        { onConflict: 'session_id,coder_id', ignoreDuplicates: true },
      );
  } catch {
    // Progress is derived convenience; never fail a coding on it.
  }
}

// ---------------------------------------------------------------------------
// Promote an ad hoc composition to a reusable action (from the coding modal).
// ---------------------------------------------------------------------------

/**
 * Create a reusable action from the modal's draft — unless an action with the
 * EXACT same composition already exists, in which case that one is returned
 * and nothing is created (the coding interface can never mint a duplicate).
 * Returns the action id to attach.
 */
export async function promoteToAction(
  codebookId: string,
  draft: ActionDraft,
): Promise<{ actionId: string; created: boolean }> {
  await requireEditor();
  const schema = await schemaFor(codebookId);
  const qLites = schema.questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    kind: q.kind,
    required: q.required,
    options: q.options.map((o) => ({ id: o.id, label: o.label })),
  }));
  const answers = answerRows(draft.answers as Record<string, AnswerDraft>, qLites);
  const objectRoles = cleanObjectRoles(draft.objectRoles, draft.objectIds, schema.roles);
  const key = compositionKey({ moveIds: draft.moveIds, objectIds: draft.objectIds, answers, objectRoles }, qLites);
  const existing = schema.actions.find((a) => compositionKey(a, qLites) === key);
  if (existing) return { actionId: existing.id, created: false };
  const actionId = await createAction(codebookId, draft);
  return { actionId, created: true };
}

// ---------------------------------------------------------------------------
// Mint vocabulary from the coding modal (moves / objects).
//
// The same contract promoteToAction holds for actions: a name that already
// exists is RETURNED, never duplicated. Mid-coding is exactly when a coder is
// most likely to retype an entry that is already there, and a split vocabulary
// ("Goal" and "goal") is what makes agreement uncomputable later.
// ---------------------------------------------------------------------------

export async function mintMove(
  codebookId: string,
  { name, minObjects }: { name: string; minObjects?: number },
): Promise<{ move: ActionMove; created: boolean }> {
  await requireEditor();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('mintMove: name is required.');
  const schema = await schemaFor(codebookId);
  const existing = findMoveByName(schema.moves, trimmed);
  if (existing) return { move: existing, created: false };
  const move = await createMove(codebookId, { name: trimmed, minObjects });
  return { move, created: true };
}

export async function mintObject(
  codebookId: string,
  { name, parentId }: { name: string; parentId?: string | null },
): Promise<{ object: ActionObject; created: boolean }> {
  await requireEditor();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('mintObject: name is required.');
  const parent = parentId || null;
  const schema = await schemaFor(codebookId);
  const problem = parentProblem(schema.objects, null, parent);
  if (problem) throw new Error(`mintObject: ${problem}`);
  const existing = findObjectByName(schema.objects, trimmed, parent);
  if (existing) return { object: existing, created: false };
  const object = await createObject(codebookId, { name: trimmed, parentId: parent });
  return { object, created: true };
}

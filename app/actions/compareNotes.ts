'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { pageAll } from '@/lib/supabase/pageAll';
import { requireAuthUser } from '@/lib/auth/supabase-auth';

/**
 * compareNotes — the per-viewer REVIEW LAYER on the compare screen
 * (cb_compare_notes, migration 43).
 *
 * A note is one coder's remark about a segment's coding during reconciliation:
 *  - 'comment'         — the author's own interpretation note;
 *  - 'change_request'  — asks the coder in `aboutCoderId` to change THEIR
 *                        coding on this segment. The addressee can resolve it.
 *
 * Notes never touch cb_annotations — interpretation and coding stay separate
 * layers. RLS: any authed member reads; author writes; author OR addressee
 * updates (so requests can be resolved by their target).
 */

export type CompareNoteView = {
  id: string;
  segmentId: string;
  authorId: string;
  aboutCoderId: string | null;
  kind: 'comment' | 'change_request';
  body: string;
  resolvedAt: string | null;
  createdAt: string;
};

export async function listCompareNotes(sessionId: string): Promise<CompareNoteView[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { data, error } = await pageAll((from, to) =>
    sb
      .from('cb_compare_notes')
      .select('id, segment_id, author_id, about_coder_id, kind, body, resolved_at, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .range(from, to),
  );
  if (error) throw new Error(`listCompareNotes failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    segmentId: r.segment_id,
    authorId: r.author_id,
    aboutCoderId: r.about_coder_id,
    kind: r.kind as 'comment' | 'change_request',
    body: r.body,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  }));
}

export async function addCompareNote(input: {
  sessionId: string;
  segmentId: string;
  aboutCoderId: string | null;
  kind: 'comment' | 'change_request';
  body: string;
}): Promise<CompareNoteView> {
  const user = await requireAuthUser();
  const body = input.body.trim();
  if (!body) throw new Error('addCompareNote: empty body');
  if (input.kind === 'change_request' && !input.aboutCoderId) {
    throw new Error('addCompareNote: a change request needs an addressee');
  }
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_compare_notes')
    .insert({
      session_id: input.sessionId,
      segment_id: input.segmentId,
      author_id: user.id,
      about_coder_id: input.aboutCoderId,
      kind: input.kind,
      body,
    })
    .select('id, segment_id, author_id, about_coder_id, kind, body, resolved_at, created_at')
    .single();
  if (error || !data) throw new Error(`addCompareNote failed: ${error?.message ?? 'no row'}`);
  return {
    id: data.id,
    segmentId: data.segment_id,
    authorId: data.author_id,
    aboutCoderId: data.about_coder_id,
    kind: data.kind as 'comment' | 'change_request',
    body: data.body,
    resolvedAt: data.resolved_at,
    createdAt: data.created_at,
  };
}

export async function editCompareNote(id: string, body: string): Promise<void> {
  await requireAuthUser();
  const trimmed = body.trim();
  if (!trimmed) throw new Error('editCompareNote: empty body');
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_compare_notes')
    .update({ body: trimmed, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`editCompareNote failed: ${error.message}`);
}

/** Toggle resolution. RLS admits the author or the addressee. */
export async function setCompareNoteResolved(id: string, resolved: boolean): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_compare_notes')
    .update({ resolved_at: resolved ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) throw new Error(`setCompareNoteResolved failed: ${error.message}`);
}

export async function deleteCompareNote(id: string): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_compare_notes').delete().eq('id', id);
  if (error) throw new Error(`deleteCompareNote failed: ${error.message}`);
}

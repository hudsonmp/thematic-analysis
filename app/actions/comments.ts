'use server';

import { cbFrom } from '@/lib/supabase/guard';
import type { Tables } from '@/lib/types/cb-db';
import { requireEditor } from '@/lib/auth/roles';

type CoderComment = Tables<'cb_coder_comments'>;

/**
 * Add a coder comment on a code (optionally pinned to a specific version).
 *
 * `author` is supplied by the UI — the coder's name or initials — rather than
 * derived server-side. We require it to be a non-empty string so
 * comments are always attributable; an unattributed comment is worse than none
 * in a reliability-coding context.
 *
 * `codeVersion` is optional: null/omitted means the comment is about the code in
 * general (not a specific version). When provided it must reference an existing
 * `(code_id, version)` pair — the DB FK to `cb_code_versions` enforces that.
 *
 * Inserted with `resolved=false` (DB default); returns the new row.
 */
export async function addComment({
  codeId,
  codeVersion,
  author,
  body,
}: {
  codeId: string;
  codeVersion?: number | null;
  author: string;
  body: string;
}): Promise<CoderComment> {
  await requireEditor(); // viewers are read-only
  if (typeof author !== 'string' || author.trim() === '') {
    throw new Error('addComment: author is required (coder name/initials supplied by UI).');
  }
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('addComment: body must be a non-empty string.');
  }

  const res = await cbFrom('cb_coder_comments')
    .insert({
      code_id: codeId,
      code_version: codeVersion ?? null,
      author: author.trim(),
      body,
      resolved: false,
    })
    .select('*')
    .single();
  if (res.error || !res.data) {
    throw new Error(`addComment failed: ${res.error?.message ?? 'no row returned'}`);
  }
  return res.data;
}

/** List a code's comments, oldest first (thread order). */
export async function listComments(codeId: string): Promise<CoderComment[]> {
  const res = await cbFrom('cb_coder_comments')
    .select('*')
    .eq('code_id', codeId)
    .order('created_at', { ascending: true });
  if (res.error) {
    throw new Error(`listComments failed: ${res.error.message}`);
  }
  return res.data ?? [];
}

/** Flip a comment's resolved flag (resolve / re-open). */
export async function setCommentResolved(commentId: string, resolved: boolean): Promise<void> {
  await requireEditor(); // viewers are read-only
  const { error } = await cbFrom('cb_coder_comments').update({ resolved }).eq('id', commentId);
  if (error) throw new Error(`setCommentResolved failed: ${error.message}`);
}

/** Delete a comment outright. */
export async function deleteComment(commentId: string): Promise<void> {
  await requireEditor(); // viewers are read-only
  const { error } = await cbFrom('cb_coder_comments').delete().eq('id', commentId);
  if (error) throw new Error(`deleteComment failed: ${error.message}`);
}

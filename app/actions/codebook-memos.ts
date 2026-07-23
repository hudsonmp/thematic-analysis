'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { requireEditor } from '@/lib/auth/roles';
import type { Tables } from '@/lib/types/cb-db';

/**
 * Codebook memos — instrument-level "I know I'm missing a code" notes.
 *
 * A memo is what a coder writes when a code SHOULD exist (recalled from the
 * literature, noticed as a gap mid-session) but defining it properly would
 * break the current activity's flow. Deliberately NOT a code: a stub code with
 * a guessed slug pollutes the picker and the triage queue with half-decisions;
 * a memo parks the recall cue and defers definition work to a codebook-editing
 * sitting. Not an annotation either — there is no transcript span to anchor
 * (that case is a bookmark + note). Distinct from legacy `cb_memos`, which are
 * per-SESSION analytic notes keyed by pid.
 *
 * Writes go through the USER client so the PERMISSIVE editor-only RLS on
 * `cb_codebook_memos` is enforced by Postgres; `requireEditor()` is the
 * belt-and-suspenders guard that turns a silent RLS no-op into a clean error.
 */

export type CodebookMemo = Tables<'cb_codebook_memos'>;

/** All memos for a codebook: open first, then resolved; newest first within each. */
export async function listCodebookMemos(codebookId: string): Promise<CodebookMemo[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_codebook_memos')
    .select('*')
    .eq('codebook_id', codebookId)
    .order('resolved_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listCodebookMemos failed: ${error.message}`);
  return data ?? [];
}

export async function createCodebookMemo(
  codebookId: string,
  body: string,
): Promise<CodebookMemo> {
  await requireEditor();
  const user = await requireAuthUser();
  const trimmed = (body ?? '').trim();
  if (trimmed === '') throw new Error('createCodebookMemo: body is required.');
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_codebook_memos')
    .insert({ codebook_id: codebookId, author_id: user.id, body: trimmed })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`createCodebookMemo failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Resolve/unresolve a memo. Resolution means "this became a real code (or was
 * judged not to be one)" — the row survives as a record of the lead, so the
 * instrument's audit trail keeps WHY codes appeared between sittings.
 */
export async function setCodebookMemoResolved(id: string, resolved: boolean): Promise<void> {
  await requireEditor();
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_codebook_memos')
    .update({ resolved_at: resolved ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) throw new Error(`setCodebookMemoResolved failed: ${error.message}`);
}

export async function deleteCodebookMemo(id: string): Promise<void> {
  await requireEditor();
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_codebook_memos').delete().eq('id', id);
  if (error) throw new Error(`deleteCodebookMemo failed: ${error.message}`);
}

'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { requireEditor } from '@/lib/auth/roles';
import type { Tables } from '@/lib/types/cb-db';

/**
 * Retrospective analysis — the question BANK and per-participant MEMOS.
 *
 * The bank (`cb_retro_questions`) is the codebook's canonical retrospective
 * structure: main questions with optional SUBQUESTIONS (one level). Memos
 * attach to BANK ids, not to the ad-hoc asked-question observations, because
 * post-hoc analysis needs every participant's memo under one stable question —
 * the observations record what was ASKED to one pid; the bank records what the
 * instrument MEANS to compare across pids.
 *
 * A memo is one per (question, session, author) — an evolving analytic note,
 * upserted, not a thread. Deliberately plain text: retrospective answers are
 * context-dependent on how that participant solved the task, so the memo
 * captures situated meaning FIRST; themes come later, across memos.
 */

export type RetroQuestion = Tables<'cb_retro_questions'>;
export type RetroMemo = Tables<'cb_retro_memos'>;

/** The bank, mains ordered by position then age, subs nested under each. */
export async function listRetroQuestions(
  codebookId: string,
): Promise<(RetroQuestion & { subs: RetroQuestion[] })[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_retro_questions')
    .select('*')
    .eq('codebook_id', codebookId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listRetroQuestions failed: ${error.message}`);
  const rows = data ?? [];
  const mains = rows.filter((r) => r.parent_id === null);
  return mains.map((m) => ({ ...m, subs: rows.filter((r) => r.parent_id === m.id) }));
}

export async function createRetroQuestion(
  codebookId: string,
  { text, parentId }: { text: string; parentId?: string | null },
): Promise<RetroQuestion> {
  await requireEditor();
  await requireAuthUser();
  const trimmed = (text ?? '').trim();
  if (trimmed === '') throw new Error('createRetroQuestion: text is required.');
  const sb = await createUserServerClient();
  const { data: maxRow } = await sb
    .from('cb_retro_questions')
    .select('position')
    .eq('codebook_id', codebookId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data, error } = await sb
    .from('cb_retro_questions')
    .insert({
      codebook_id: codebookId,
      parent_id: parentId ?? null,
      text: trimmed,
      position: (maxRow?.position ?? -1) + 1,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`createRetroQuestion failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/** Delete a question. Subquestions and memos cascade — deleting a main is an
 *  instrument edit, not housekeeping; the UI confirms before calling. */
export async function deleteRetroQuestion(id: string): Promise<void> {
  await requireEditor();
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_retro_questions').delete().eq('id', id);
  if (error) throw new Error(`deleteRetroQuestion failed: ${error.message}`);
}

/**
 * Seed the canonical structure when the bank is empty: the participant task's
 * retrospective pages (canonical episode names from episodes-from-events) become
 * the mains. Idempotent-by-guard: no-op unless the bank has zero rows.
 */
export async function seedRetroQuestions(codebookId: string): Promise<void> {
  await requireEditor();
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { count, error: countErr } = await sb
    .from('cb_retro_questions')
    .select('id', { count: 'exact', head: true })
    .eq('codebook_id', codebookId);
  if (countErr) throw new Error(`seedRetroQuestions failed: ${countErr.message}`);
  if ((count ?? 0) > 0) return;
  const seeds = [
    'Scenario Retrospective',
    'General Retrospective Question I',
    'General Retrospective Question II',
    'General Retrospective Question III',
  ];
  const { error } = await sb
    .from('cb_retro_questions')
    .insert(seeds.map((text, i) => ({ codebook_id: codebookId, text, position: i })));
  if (error) throw new Error(`seedRetroQuestions failed: ${error.message}`);
}

/** Every memo on this session (all authors — reading a co-coder's memo is part
 *  of reconciliation). The UI edits only the caller's own rows. */
export async function listRetroMemos(sessionId: string): Promise<RetroMemo[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_retro_memos')
    .select('*')
    .eq('session_id', sessionId);
  if (error) throw new Error(`listRetroMemos failed: ${error.message}`);
  return data ?? [];
}

/** Create-or-update MY memo for (question, session). Empty body is a valid
 *  save (clearing a memo), so no emptiness guard. */
export async function upsertRetroMemo(
  questionId: string,
  sessionId: string,
  body: string,
): Promise<RetroMemo> {
  await requireEditor();
  const user = await requireAuthUser();
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_retro_memos')
    .upsert(
      {
        question_id: questionId,
        session_id: sessionId,
        author_id: user.id,
        body,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'question_id,session_id,author_id' },
    )
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`upsertRetroMemo failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

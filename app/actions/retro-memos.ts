'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { requireEditor } from '@/lib/auth/roles';
import type { Tables } from '@/lib/types/cb-db';
import { getShownStudy, listCodebooks, listCodebookTree } from '@/app/actions/codebook';

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

type AuthoredQuestion = { id?: unknown; text?: unknown };
type AuthoredModule = {
  type?: unknown;
  retrospective?: unknown;
  questions?: unknown;
};

/**
 * SYNC the bank from the study's authored task: the questions each participant
 * actually saw live in `studies.authored_data` — the task module's
 * `retrospective` array (the per-scenario retro question) and the
 * retrospective_report module's `questions` (the general retro questions).
 * Read-only on study data (getShownStudy → studyFrom guard).
 *
 * Idempotent: a question already in the bank (by source_key or by
 * case-insensitive text) is skipped, so re-syncing after an instrument tweak
 * adds only what's new. `source_key` records the canonical step
 * (scenario_retro, general_retro_N) so the panel can auto-select the question
 * whose retrospective episode is playing. V1's placeholder rows ("General
 * Retrospective Question I"…) are retired when they carry no subquestions and
 * no memos — they were scaffolding, not data.
 */
export async function syncRetroQuestionsFromStudy(codebookId: string): Promise<void> {
  await requireEditor();
  await requireAuthUser();
  const study = await getShownStudy();
  const sb = await createUserServerClient();

  const modules: AuthoredModule[] = Array.isArray(
    (study?.authored_data as { modules?: unknown })?.modules,
  )
    ? ((study!.authored_data as { modules: unknown[] }).modules as AuthoredModule[])
    : [];

  const wanted: { text: string; sourceKey: string }[] = [];
  for (const m of modules) {
    if (Array.isArray(m.retrospective)) {
      (m.retrospective as AuthoredQuestion[]).forEach((q, i) => {
        if (typeof q?.text === 'string' && q.text.trim() !== '') {
          wanted.push({
            text: q.text.trim(),
            sourceKey: i === 0 ? 'scenario_retro' : `scenario_retro_${i + 1}`,
          });
        }
      });
    }
    if (m.type === 'retrospective_report' && Array.isArray(m.questions)) {
      (m.questions as AuthoredQuestion[]).forEach((q, i) => {
        if (typeof q?.text === 'string' && q.text.trim() !== '') {
          wanted.push({ text: q.text.trim(), sourceKey: `general_retro_${i + 1}` });
        }
      });
    }
  }
  // Two task variants (pilot/study) can repeat the same set — dedupe by text.
  const seen = new Set<string>();
  const unique = wanted.filter((w) => {
    const k = w.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const { data: existingRows, error: exErr } = await sb
    .from('cb_retro_questions')
    .select('id, text, source_key, parent_id')
    .eq('codebook_id', codebookId);
  if (exErr) throw new Error(`syncRetroQuestionsFromStudy failed: ${exErr.message}`);
  const rows = existingRows ?? [];
  const haveText = new Set(rows.map((r) => r.text.trim().toLowerCase()));
  const haveKey = new Set(rows.map((r) => r.source_key).filter(Boolean));

  let pos = rows.length;
  const inserts = unique
    .filter((w) => !haveText.has(w.text.toLowerCase()) && !haveKey.has(w.sourceKey))
    .map((w) => ({
      codebook_id: codebookId,
      text: w.text,
      source_key: w.sourceKey,
      position: pos++,
    }));
  if (inserts.length > 0) {
    const { error } = await sb.from('cb_retro_questions').insert(inserts);
    if (error) throw new Error(`syncRetroQuestionsFromStudy failed: ${error.message}`);
  }

  // Retire empty v1 placeholders.
  const placeholders = rows.filter(
    (r) =>
      r.source_key === null &&
      r.parent_id === null &&
      /^(general retrospective question (i|ii|iii)|scenario retrospective)$/i.test(
        r.text.trim(),
      ),
  );
  for (const ph of placeholders) {
    const { count: subCount } = await sb
      .from('cb_retro_questions')
      .select('id', { count: 'exact', head: true })
      .eq('parent_id', ph.id);
    const { count: memoCount } = await sb
      .from('cb_retro_memos')
      .select('id', { count: 'exact', head: true })
      .eq('question_id', ph.id)
      .neq('body', '');
    if ((subCount ?? 0) === 0 && (memoCount ?? 0) === 0) {
      await sb.from('cb_retro_questions').delete().eq('id', ph.id);
    }
  }
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


/** The popup-shaped code list of the study's RETROSPECTIVE codebook (name
 *  matching /retro/i), or null when no such codebook exists. The player swaps
 *  the coding popup onto this whenever the analyst is in retrospective context
 *  (retro mode, or the playhead inside a retrospective episode) — retro
 *  answers are coded against their own instrument, not the transcript's. */
export async function getRetroCodebook(): Promise<{
  id: string;
  name: string;
  codes: {
    id: string;
    mnemonic: string;
    origin: string;
    definition: string | null;
    exemplars: string[];
    counterExample: string | null;
  }[];
} | null> {
  await requireAuthUser();
  const all = await listCodebooks();
  const cb = all.find((c) => /retro/i.test(c.name));
  if (!cb) return null;
  const tree = await listCodebookTree(cb.id);
  const exemplarTexts = (raw: unknown): string[] =>
    Array.isArray(raw)
      ? raw
          .map((e) =>
            e && typeof e === 'object' && typeof (e as { text?: unknown }).text === 'string'
              ? (e as { text: string }).text
              : '',
          )
          .filter((t) => t !== '')
      : [];
  return {
    id: cb.id,
    name: cb.name,
    codes: tree.codes.map((c) => ({
      id: c.id,
      mnemonic: c.mnemonic,
      origin: c.origin,
      definition: c.current?.definition ?? null,
      exemplars: exemplarTexts(c.current?.exemplars),
      counterExample: c.current?.disconfirming_pattern ?? null,
    })),
  };
}

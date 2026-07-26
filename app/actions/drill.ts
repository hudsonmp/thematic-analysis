'use server';

import { after } from 'next/server';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { listCodebooks, listCodebookTree } from '@/app/actions/codebook';
import {
  gradeCard,
  newCard,
  parseCard,
  serializeCard,
  type DrillRating,
  type FsrsCardJson,
} from '@/lib/drill/schedule';
import type { DrillCode } from '@/lib/drill/cards';
import type { Json } from '@/lib/types/cb-db';

/**
 * Drill — FSRS-scheduled retrieval practice over the A PRIORI codes.
 *
 * Deck membership is derived, never stored: every non-retired code with
 * origin 'a_priori' across ALL codebooks is drillable, so a code added to the
 * instrument tomorrow appears as a new card with no sync step. Emergent codes
 * are deliberately excluded — they were coined BY the coders from the data;
 * drilling them would be memorizing your own conclusions.
 *
 * Scheduling state is per-user (RLS: write-own, read-all), so each coder has
 * their own FSRS trajectory over the shared instrument.
 */

export type DrillState = {
  codeId: string;
  cardType: string;
  due: string;
  fsrs: unknown;
  reps: number;
};

export type DrillDeck = { codes: DrillCode[]; states: DrillState[] };

export async function getDrillDeck(): Promise<DrillDeck> {
  const user = await requireAuthUser();

  const books = await listCodebooks();
  const trees = await Promise.all(books.map((b) => listCodebookTree(b.id)));

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

  const codes: DrillCode[] = trees.flatMap((tree) =>
    tree.codes
      .filter((c) => c.origin === 'a_priori' && c.retired_at === null)
      .map((c) => ({
        id: c.id,
        mnemonic: c.mnemonic,
        definition: c.current?.definition ?? null,
        counterExample: c.current?.disconfirming_pattern ?? null,
        exemplars: exemplarTexts(c.current?.exemplars),
        facetValueIds: c.facetValueIds,
        codebookName: tree.codebook.name,
      })),
  );

  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_drill_states')
    .select('code_id, card_type, due, fsrs')
    .eq('user_id', user.id);
  if (error) throw new Error(`getDrillDeck failed: ${error.message}`);

  const states: DrillState[] = (data ?? []).map((s) => ({
    codeId: s.code_id,
    cardType: s.card_type,
    due: s.due,
    fsrs: s.fsrs,
    reps: (s.fsrs as FsrsCardJson | null)?.reps ?? 0,
  }));

  return { codes, states };
}

/**
 * One review. The FSRS transition is computed SERVER-side from the stored
 * card, so a stale client can't corrupt the schedule. Grade floor enforced
 * HERE, not trusted from the client: a wrong pick is ALWAYS Again (1); a
 * correct pick takes the learner's Again/Hard/Good/Easy rating (default
 * Good). The state upsert is in the critical path — the client needs the new
 * due date — but the append-only review log rides in `after()`, off the
 * perceived latency.
 */
export async function submitDrillReview(input: {
  codeId: string;
  cardType: 'classify' | 'recall' | 'name';
  correct: boolean;
  rating?: DrillRating;
  chosenCodeId: string | null;
  elapsedMs: number | null;
}): Promise<DrillState> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();
  const now = new Date();

  const requested = [1, 2, 3, 4].includes(input.rating as number)
    ? (input.rating as DrillRating)
    : 3;
  const grade: DrillRating = input.correct ? requested : 1;

  const { data: existing, error: readErr } = await sb
    .from('cb_drill_states')
    .select('fsrs')
    .eq('user_id', user.id)
    .eq('code_id', input.codeId)
    .eq('card_type', input.cardType)
    .maybeSingle();
  if (readErr) throw new Error(`submitDrillReview failed: ${readErr.message}`);

  const card = existing ? parseCard(existing.fsrs as unknown as FsrsCardJson) : newCard(now);
  const { card: next, rating } = gradeCard(card, grade, now);
  const fsrsJson = serializeCard(next) as unknown as Json;

  const { error: upsertErr } = await sb.from('cb_drill_states').upsert(
    {
      user_id: user.id,
      code_id: input.codeId,
      card_type: input.cardType,
      due: next.due.toISOString(),
      fsrs: fsrsJson,
      updated_at: now.toISOString(),
    },
    { onConflict: 'user_id,code_id,card_type' },
  );
  if (upsertErr) throw new Error(`submitDrillReview failed: ${upsertErr.message}`);

  after(async () => {
    const { error } = await sb.from('cb_drill_reviews').insert({
      user_id: user.id,
      code_id: input.codeId,
      card_type: input.cardType,
      rating,
      correct: input.correct,
      chosen_code_id: input.chosenCodeId,
      elapsed_ms: input.elapsedMs,
    });
    if (error) console.error('[drill] review log insert failed:', error.message);
  });

  return {
    codeId: input.codeId,
    cardType: input.cardType,
    due: next.due.toISOString(),
    fsrs: fsrsJson,
    reps: next.reps,
  };
}

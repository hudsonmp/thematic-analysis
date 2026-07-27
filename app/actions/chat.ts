'use server';

import { studyFrom } from '@/lib/supabase/study-guard';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { pageAll } from '@/lib/supabase/pageAll';
import { requireAuthUser } from '@/lib/auth/supabase-auth';

// ---------------------------------------------------------------------------
// Session AI-chat data layer (study-table READ) — Task 1 of the chat-replay
// feature.
//
// Returns the participant's LLM-assistant conversation for a coded session so the
// coder can replay it ALIGNED to the recording timeline beside the transcript and
// flags (alignment itself is pure — see lib/chat/align.ts). The chat lives in the
// IRB-covered, READ-ONLY study tables `study_assistant_messages` + `users`.
//
// Two clients, each matching the table's established access path:
//   * `cb_sessions` (a cb_ table) → the USER client (anon key bound to the
//     researcher's JWT), exactly as app/actions/observations.ts:
//     listObservationsForSession resolves `pid_label`.
//   * `users` + `study_assistant_messages` (study tables) → `studyFrom` (the
//     SELECT-only study-read guard, lib/supabase/study-guard.ts), exactly as
//     app/actions/live.ts reads `users`/`study_events`. It runs on the anon-key
//     USER client: study tables carry a SELECT-only RLS policy for
//     `authenticated` (and no write policy), so reads succeed on the
//     researcher's JWT and the read-only guarantee is STRUCTURAL (RLS + the
//     guard + the `check-no-study-writes` lint guard), not just discipline —
//     every query below is a `.select()`; there is NOT one write to a study
//     table, and a write on this credential would be refused by Postgres.
//
// `requireAuthUser()` gates first, so an unauthenticated request never reaches the
// study stream. A session with no chat (or a pid with none) returns [] — never a
// throw — so the replay pane renders an empty state rather than crashing.
// ---------------------------------------------------------------------------

/**
 * One assistant-chat message as the replay pane consumes it: the display fields
 * (`role`, `content`) plus `createdAt` (the absolute instant the alignment module
 * projects onto the recording clock) and the `moduleId`/`scenarioIdx` segmentation
 * (carried for a later segmentation UI; the pane shows dialogue text only for now).
 * `role` is narrowed to the two values the study emits.
 */
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** study_assistant_messages.created_at (ISO timestamptz). t for offset math. */
  createdAt: string;
  moduleId: string;
  scenarioIdx: number | null;
};

/**
 * List a SESSION's participant assistant-chat messages, OLDEST-first
 * (`created_at` ascending — playback order, the order alignChat then places on the
 * timeline). Resolves the session's `pid_label` (mirroring
 * `listObservationsForSession`), resolves that pid to a `users.id`, then selects
 * that user's `study_assistant_messages`.
 *
 * READ-ONLY (three `.select()`s, no study-table write). Returns [] — not a throw —
 * when the session is unknown, has no `pid_label`, the pid is unknown, or the
 * participant has no chat: a session without recorded chat must render an empty
 * state, not crash. `role` is narrowed to `'user' | 'assistant'` (the only values
 * the study writes); any other value is coerced to `'assistant'` defensively.
 */
export async function listSessionAssistantChat(
  sessionId: string,
): Promise<ChatMessage[]> {
  await requireAuthUser();
  const id = (sessionId ?? '').trim();
  if (!id) return [];

  // 1. Resolve the session's pid_label via the USER client (cb_ table), exactly as
  //    listObservationsForSession does. A missing session yields [] (no throw): the
  //    replay pane just shows its empty state.
  const userSb = await createUserServerClient();
  const sessRes = await userSb
    .from('cb_sessions')
    .select('pid_label')
    .eq('id', id)
    .maybeSingle();
  if (sessRes.error) {
    throw new Error(
      `listSessionAssistantChat: cb_sessions read failed: ${sessRes.error.message}`,
    );
  }
  const pidLabel = (sessRes.data?.pid_label ?? '').trim();
  if (!pidLabel) return [];

  // 2-3. Study reads via `studyFrom` (SELECT-only guard, mirrors live.ts).
  //       Resolve pid → users.id, then select that user's chat ascending. Either
  //       step coming back empty yields [] (no chat for this participant).

  // `pid` is expected unique; a duplicate surfaces as a `.maybeSingle()` error
  // (caught below → throw), never a silently wrong user.
  const userRes = await (await studyFrom('users'))
    .select('id')
    .eq('pid', pidLabel)
    .maybeSingle();
  if (userRes.error) {
    throw new Error(
      `listSessionAssistantChat: users read failed: ${userRes.error.message}`,
    );
  }
  const userId = userRes.data?.id;
  if (!userId) return [];

  // Paged past PostgREST's silent 1000-row cap (read-only study select).
  const studyMsgs = await studyFrom('study_assistant_messages');
  const msgRes = await pageAll((from, to) =>
    studyMsgs
      .select('id, role, content, created_at, module_id, scenario_idx')
      .eq('user_id', userId)
      // created_at is the timeline key; id is a deterministic tiebreaker for two
      // turns sharing a millisecond (matches alignChat's stable sort).
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (msgRes.error) {
    throw new Error(
      `listSessionAssistantChat: study_assistant_messages read failed: ${msgRes.error.message}`,
    );
  }

  return (msgRes.data ?? []).map((m) => ({
    id: m.id,
    // The DB types `role` as plain text; the study only ever writes 'user' /
    // 'assistant'. Narrow defensively — anything unexpected reads as 'assistant'.
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
    createdAt: m.created_at,
    moduleId: m.module_id,
    scenarioIdx: m.scenario_idx,
  }));
}

'use server';

import { studyFrom } from '@/lib/supabase/study-guard';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { pageAll } from '@/lib/supabase/pageAll';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getShownStudy } from '@/app/actions/codebook';
import { taskModuleIdFrom } from '@/lib/study/task-module';
import type { Json } from '@/lib/types/cb-db';

// ---------------------------------------------------------------------------
// Session SPEC-replay data layer (study-table READ) — Task SV1 of the
// specification-mode feature.
//
// Returns the participant's EVOLVING spec text + entity table for a coded session
// so the "Specification" transcript mode can REPLAY it synced to the recording
// (reconstruction itself is pure — see lib/spec/reconstruct.ts; alignment to the
// recording clock happens client-side, exactly like chat). The spec evolution
// lives in the IRB-covered, READ-ONLY study table `public.study_events`:
//   * event_type = 'spec_edit'      → payload.value = the ENTIRE spec string
//   * event_type = 'entities_edit'  → payload.value = JSON.stringify(Entity[])
// Each row carries the FULL value (not a diff), ~1s-debounced on each edit.
//
// Two clients, each matching the established access path (mirrors
// app/actions/chat.ts:listSessionAssistantChat):
//   * `cb_sessions` (a cb_ table) → the USER client (anon key bound to the
//     researcher's JWT), to resolve the session's `pid_label`.
//   * `users` + `study_events` (study tables) → `studyFrom` (the SELECT-only
//     study-read guard, lib/supabase/study-guard.ts; mirrors app/actions/live.ts),
//     which runs on the anon-key USER client. Study tables carry a SELECT-only
//     RLS policy for `authenticated`, so the read-only guarantee is STRUCTURAL
//     (RLS + the guard + the `check-no-study-writes` lint guard), not just
//     discipline — every query below is a `.select()`; there is NOT one write to
//     a study table, and a write on this credential would be refused by Postgres.
//
// TASK-MODULE FILTER: a participant emits spec/entities edits under TWO modules —
// a warmup task and the real task. We filter to the REAL task's `module_id`
// (resolved the SAME way the live anchor does — the `type:'task'` module in the
// shown study's `authored_data`, via the shared lib/study/task-module.ts) so warmup-spec
// edits don't render on the real-task video. If the task module can't be resolved
// (no shown study / no task module), we DO NOT silently guess — we include all
// edits and the caller can detect this absence; see the inline note.
//
// `requireAuthUser()` gates first. Every empty case (unknown session, no
// pid_label, unknown pid, no rows) returns the EMPTY timeline shape — never a
// throw — so the replay pane renders an empty state rather than crashing.
// ---------------------------------------------------------------------------

/** One raw spec/entities edit row as the replay pane consumes it: the absolute
 *  instant it was committed (`createdAt`, ISO timestamptz — the t the alignment
 *  module projects onto the recording clock) and the FULL serialized value at that
 *  instant. For spec edits, `value` is the entire spec string; for entity edits,
 *  `value` is `JSON.stringify(Entity[])`. Raw — alignment + reconstruction happen
 *  client-side later (like chat), via lib/spec/reconstruct.ts. */
export type SpecEditRow = {
  /** study_events.created_at (ISO timestamptz). t for offset math. */
  createdAt: string;
  /** payload.value — the FULL value at this instant. */
  value: string;
};

/** The two raw edit streams for a session, OLDEST-first. The spec textarea and
 *  the entity table debounce separately, so they are returned as SEPARATE streams
 *  (the reconstructor resolves each independently at a playhead). */
export type SpecTimelineResult = {
  specEdits: SpecEditRow[];
  entityEdits: SpecEditRow[];
};

/**
 * List a SESSION's participant spec-evolution edits (`spec_edit` +
 * `entities_edit`), OLDEST-first (`created_at` ascending — playback order).
 * Resolves the session's `pid_label` (mirroring chat.ts), resolves that pid to a
 * `users.id`, resolves the REAL task `module_id` (mirroring live.ts), then selects
 * that user's spec/entities edits on the task module.
 *
 * READ-ONLY (every query is a `.select()`; no study-table write). Returns the
 * empty timeline `{ specEdits: [], entityEdits: [] }` — not a throw — when the
 * session is unknown, has no `pid_label`, the pid is unknown, or the participant
 * has no spec edits, so a session without recorded spec edits renders an empty
 * state rather than crashing.
 */
export async function listSessionSpecTimeline(
  sessionId: string,
): Promise<SpecTimelineResult> {
  await requireAuthUser();
  const empty: SpecTimelineResult = { specEdits: [], entityEdits: [] };

  const id = (sessionId ?? '').trim();
  if (!id) return empty;

  // 1. Resolve the session's pid_label via the USER client (cb_ table), exactly as
  //    chat.ts / observations.ts do. A missing session yields the empty timeline.
  const userSb = await createUserServerClient();
  const sessRes = await userSb
    .from('cb_sessions')
    .select('pid_label')
    .eq('id', id)
    .maybeSingle();
  if (sessRes.error) {
    throw new Error(
      `listSessionSpecTimeline: cb_sessions read failed: ${sessRes.error.message}`,
    );
  }
  const pidLabel = (sessRes.data?.pid_label ?? '').trim();
  if (!pidLabel) return empty;

  // 2. Study reads via `studyFrom` (SELECT-only guard, mirrors live.ts). Resolve
  //    pid → users.id. A missing user yields the empty timeline (no spec for this
  //    pid).
  const userRes = await (await studyFrom('users'))
    .select('id')
    .eq('pid', pidLabel)
    .maybeSingle();
  if (userRes.error) {
    throw new Error(
      `listSessionSpecTimeline: users read failed: ${userRes.error.message}`,
    );
  }
  const userId = userRes.data?.id;
  if (!userId) return empty;

  // 3. Resolve the REAL task module_id (the `type:'task'` module in the shown
  //    study's authored_data — the SAME shared resolution the live clock anchors
  //    on, lib/study/task-module.ts:taskModuleIdFrom). If it resolves, we scope
  //    the edit query to it so warmup-spec edits never render on the real-task
  //    video. If it does NOT resolve (no shown study / no task module), we do NOT
  //    silently guess a module — we include ALL of the user's spec/entities edits.
  const taskModuleId = taskModuleIdFrom((await getShownStudy())?.authored_data ?? null);

  // 4. Select this user's spec_edit + entities_edit rows, ascending by created_at.
  //    Scoped to the task module when resolvable. Two `.select()`s, no write.
  //    Paged past PostgREST's silent 1000-row cap (read-only study select) —
  //    long sessions accumulate hundreds of debounced autosaves.
  const studyEvents = await studyFrom('study_events');
  const evRes = await pageAll((from, to) => {
    let query = studyEvents
      .select('event_type, payload, created_at')
      .eq('user_id', userId)
      .in('event_type', ['spec_edit', 'entities_edit'])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (taskModuleId) {
      query = query.eq('module_id', taskModuleId);
    }
    return query.range(from, to);
  });
  if (evRes.error) {
    throw new Error(
      `listSessionSpecTimeline: study_events read failed: ${evRes.error.message}`,
    );
  }

  const specEdits: SpecEditRow[] = [];
  const entityEdits: SpecEditRow[] = [];
  for (const ev of evRes.data ?? []) {
    const value = payloadValue(ev.payload);
    if (value === null) continue; // skip a payload with no string `value`
    const row: SpecEditRow = { createdAt: ev.created_at, value };
    if (ev.event_type === 'spec_edit') specEdits.push(row);
    else if (ev.event_type === 'entities_edit') entityEdits.push(row);
  }

  return { specEdits, entityEdits };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Extract `payload.value` as a string, or null if the payload is malformed or
 *  carries no string `value`. Defensive against an oddly-shaped jsonb payload
 *  (mirrors live.ts's `stepDestination` narrowing). */
function payloadValue(payload: Json): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>).value;
  return typeof value === 'string' ? value : null;
}

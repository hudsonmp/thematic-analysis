'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import type { Tables } from '@/lib/types/cb-db';

type Observation = Tables<'cb_observations'>;

// ---------------------------------------------------------------------------
// Live observations data layer — Task 2 of the live co-observation feature.
//
// An "observation" is one thing a co-observer logged about a participant during a
// live session: a tap of a preset FLAG (cb_flag_types — e.g. "Confusion") and/or
// a free-text NOTE. Rows are keyed on `pid` (the participant label) so they persist
// independently of any one recording; `session_id` is a nullable link to the live
// cb_sessions row and `flag_type_id` a nullable link to the taxonomy (both
// on-delete-set-null at the DB).
//
// Ownership mirrors cb_annotations' read-all / write-own asymmetry, keyed on
// `created_by = auth.uid()`:
//   * SELECT is read-all (the live view shows every co-observer's taps).
//   * INSERT/UPDATE/DELETE are own-only. `created_by` is set EXPLICITLY to the
//     signed-in user's uid on insert; the `with check (created_by = auth.uid())`
//     policy admits only that value, so a forged created_by is rejected by RLS.
//
// ALL paths route through `createUserServerClient()` (the anon key bound to the
// signed-in user's JWT), NOT `cbFrom()` — the service-role client bypasses RLS,
// which would both defeat the own-write guarantee and leave `auth.uid()` null
// (failing the insert/update WITH CHECK). `created_at` takes the server default.
// ---------------------------------------------------------------------------

/**
 * One observation as the live view / playback rail consumes it: the
 * `cb_observations` row's display fields, left-joined to its `cb_flag_types`
 * (flag label + swatch color). A tap-only observation has `body: null`; a
 * bare-note observation has `flagTypeId: null` (and so `flagLabel`/`color` null).
 */
export type ObservationView = {
  id: string;
  pid: string;
  flagTypeId: string | null;
  /** The flag's label, joined from cb_flag_types; null for a bare note (no flag)
   *  and '(deleted flag)' if the flag type was removed out from under the row. */
  flagLabel: string | null;
  /** The flag's swatch color (hex), joined from cb_flag_types; null when there is
   *  no flag or the flag carried no color. */
  color: string | null;
  body: string | null;
  createdAt: string;
};

/**
 * Log an observation for a participant. `pid` is required. `flagTypeId` and `body`
 * are both optional, but AT LEAST ONE must be present — a tap-only flag has no
 * body, a bare note has no flag, but an observation with neither carries no
 * information and is rejected. `body` is trimmed; a whitespace-only body counts as
 * absent (so a whitespace-only body with no flag is rejected too).
 *
 * `created_by` is set explicitly to the signed-in user's uid: the RLS insert
 * policy is `with check (created_by = auth.uid())`, so this is both required and
 * the only value RLS admits. `created_at` takes the server default. Returns the
 * inserted row.
 */
export async function addObservation({
  pid,
  flagTypeId,
  body,
}: {
  pid: string;
  flagTypeId?: string | null;
  body?: string | null;
}): Promise<Observation> {
  const user = await requireAuthUser();

  const trimmedPid = (pid ?? '').trim();
  if (!trimmedPid) throw new Error('addObservation: pid is required.');

  const flag = flagTypeId ?? null;
  const trimmedBody = typeof body === 'string' ? body.trim() : '';
  const finalBody = trimmedBody === '' ? null : trimmedBody;

  // At least one of (flag, body) must be present — a both-null observation
  // carries no information.
  if (flag === null && finalBody === null) {
    throw new Error('addObservation: an observation needs a flag or a note.');
  }

  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_observations')
    .insert({
      pid: trimmedPid,
      flag_type_id: flag,
      body: finalBody,
      // Set explicitly to the caller's uid: RLS `with check (created_by =
      // auth.uid())` admits only the signed-in user's own id.
      created_by: user.id,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`addObservation failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * List a participant's observations in time order (`created_at` asc), each
 * left-joined to its `cb_flag_types(label, color)`. The read-all RLS policy
 * admits every co-observer's rows. `flag_type_id` is nullable, so the embed is a
 * left join: a bare note returns `null` for the joined flag (→ flagLabel/color
 * null); a tap whose flag was deleted also returns `null` (→ '(deleted flag)').
 */
export async function listObservationsForPid(pid: string): Promise<ObservationView[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_observations')
    .select('id, pid, flag_type_id, body, created_at, cb_flag_types(label, color)')
    .eq('pid', pid)
    .order('created_at', { ascending: true });
  if (error) {
    throw new Error(`listObservationsForPid failed: ${error.message}`);
  }

  return toObservationViews(data);
}

/**
 * A session's observations plus the recording anchor Task 5 needs to compute
 * offsets. `observations` is `listObservationsForPid` for the session's
 * `pid_label`; `recordingStartedAt` is the session's `recording_started_at` (ISO
 * string, or null if the recording start was never set).
 */
export type SessionObservations = {
  observations: ObservationView[];
  /** cb_sessions.recording_started_at — the t=0 anchor for offset math (Task 5). */
  recordingStartedAt: string | null;
};

/**
 * List a SESSION's observations: resolve the session's `pid_label`, then return
 * that participant's observations (same shape as `listObservationsForPid`), plus
 * the session's `recording_started_at` so the caller can compute each
 * observation's video offset as (created_at − recording_started_at) in Task 5.
 *
 * Observations are pid-keyed, not session-keyed, so this is deliberately a read
 * over the pid (NOT a `where session_id = ?` filter): a tap made before the
 * session row existed, or after it was deleted, still belongs to the participant's
 * timeline. Reads through the user client; read-all RLS admits the select.
 */
export async function listObservationsForSession(
  sessionId: string,
): Promise<SessionObservations> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const sessRes = await sb
    .from('cb_sessions')
    .select('pid_label, recording_started_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessRes.error) {
    throw new Error(
      `listObservationsForSession: cb_sessions read failed: ${sessRes.error.message}`,
    );
  }
  if (!sessRes.data) {
    throw new Error(`listObservationsForSession: no session ${sessionId}.`);
  }

  const observations = await listObservationsForPid(sessRes.data.pid_label);
  return { observations, recordingStartedAt: sessRes.data.recording_started_at };
}

/**
 * Edit an observation's note body. RLS (`using + with check (created_by =
 * auth.uid())`) admits only the author's OWN row — an update of another
 * observer's row matches zero rows (silent no-op). `body` is trimmed; an empty
 * string clears the note (a flag-only observation may legitimately have no body).
 * Returns the updated row, or null when the update matched no row (not own / not
 * found).
 */
export async function updateObservation(
  id: string,
  { body }: { body: string | null },
): Promise<Observation | null> {
  await requireAuthUser();
  const trimmed = typeof body === 'string' ? body.trim() : '';
  const finalBody = trimmed === '' ? null : trimmed;

  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_observations')
    .update({ body: finalBody })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`updateObservation failed: ${error.message}`);
  return data ?? null;
}

/**
 * Delete an observation by id. RLS (`using (created_by = auth.uid())`) admits
 * only the author's OWN row — a delete of another observer's observation matches
 * zero rows (silent no-op, not an error).
 */
export async function deleteObservation(id: string): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_observations').delete().eq('id', id);
  if (error) throw new Error(`deleteObservation failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Map raw `cb_observations` rows (with embedded flag type) to `ObservationView`. */
function toObservationViews(data: unknown): ObservationView[] {
  const rows = (data ?? []) as Array<{
    id: string;
    pid: string;
    flag_type_id: string | null;
    body: string | null;
    created_at: string;
    cb_flag_types: { label: string; color: string | null } | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    pid: r.pid,
    flagTypeId: r.flag_type_id,
    // A bare note has no flag_type_id (→ null label). A tap whose flag was deleted
    // out from under it keeps flag_type_id but the left-join is null (→ sentinel).
    flagLabel:
      r.flag_type_id === null ? null : (r.cb_flag_types?.label ?? '(deleted flag)'),
    color: r.cb_flag_types?.color ?? null,
    body: r.body,
    createdAt: r.created_at,
  }));
}

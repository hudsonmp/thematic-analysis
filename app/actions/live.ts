'use server';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getShownStudy } from '@/app/actions/codebook';
import { humanizeEvent } from '@/lib/live/humanize';
import type { Json } from '@/lib/types/cb-db';

// ---------------------------------------------------------------------------
// Live Follow data layer (study-table READS) — Task 3 of the live
// co-observation feature.
//
// These three actions back the live "current step" and provisional video clock.
// They READ the participant event stream — `users`, `study_events`, `studies` —
// which are IRB-covered, READ-ONLY tables. Every call here is a `.select()`;
// there is NOT a single write to a study table, and the `check-no-study-writes`
// lint guard verifies that.
//
// Reads go through the SERVICE-ROLE client (`createServiceRoleClient()`), the
// same path `app/actions/codebook.ts:getShownStudy` already uses to read
// `studies`. We deliberately do NOT route study reads through `cbFrom` (its
// compile-time `cb_` bound forbids `from('users')`) nor strictly require the
// user-JWT client (study-table RLS need not admit the researcher's anon JWT).
// The service-role key bypasses RLS for reads, which is fine — these are reads
// of data the researcher is entitled to see; the read-only guarantee is the
// guard + discipline, not RLS. Every action gates on `requireAuthUser()` first
// so an unauthenticated request can never reach the study stream.
// ---------------------------------------------------------------------------

/** A participant for the live PID picker. `pid` is the participant label the
 *  whole live workflow keys on; `firstName` rides beside it for the researcher's
 *  recognition — PID alone is too easy to confuse mid-session. */
export type LiveParticipant = {
  userId: string;
  pid: string;
  firstName: string;
};

/**
 * List study participants for the PID picker, ordered by `pid`. READ-ONLY:
 * a `.select()` on the `users` table (no write). `pid` is text, so the order is
 * a lexical sort on the label (matches how PIDs read in the dropdown). Selects
 * `id` + `pid` + `first_name` so the picker can show PID + name.
 */
export async function listParticipants(): Promise<LiveParticipant[]> {
  await requireAuthUser();
  const sb = createServiceRoleClient();

  const { data, error } = await sb
    .from('users')
    .select('id, pid, first_name')
    .order('pid', { ascending: true });
  if (error) throw new Error(`listParticipants failed: ${error.message}`);

  return (data ?? []).map((u) => ({
    userId: u.id,
    pid: u.pid,
    firstName: u.first_name,
  }));
}

/** The latest study event for a participant, as the live "current step" reads
 *  it: the raw fields the humanizer needs (`eventType`, `payload`, `moduleId`)
 *  plus `createdAt` for recency display. Null when the PID has no events yet. */
export type LatestEvent = {
  moduleId: string;
  eventType: string;
  payload: Json;
  createdAt: string;
};

/**
 * The most recent `study_events` row for a participant (by `pid`). READ-ONLY:
 * resolves `user_id` from `users.pid`, then selects the single newest event
 * (`created_at desc, limit 1`). Returns null when the PID is unknown or has no
 * events. Both queries are `.select()`s — no study-table write.
 */
export async function latestEventForPid(pid: string): Promise<LatestEvent | null> {
  await requireAuthUser();
  const trimmed = (pid ?? '').trim();
  if (!trimmed) return null;

  const sb = createServiceRoleClient();

  const userId = await resolveUserId(sb, trimmed);
  if (!userId) return null;

  const { data, error } = await sb
    .from('study_events')
    .select('module_id, event_type, payload, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`latestEventForPid failed: ${error.message}`);
  if (!data) return null;

  return {
    moduleId: data.module_id,
    eventType: data.event_type,
    payload: data.payload,
    createdAt: data.created_at,
  };
}

/**
 * The participant's TASK start time — the provisional video-clock anchor.
 *
 * READ-ONLY. Resolves the recorded `type:'task'` module id from the active
 * study's `authored_data` (the `studies` row), resolves `user_id` from
 * `users.pid`, then returns `min(created_at)` of that user's `module_start`
 * events on that module. The clock previews where a live flag will land in the
 * eventual recording (`now − taskStart`). Returns null when the study has no
 * task module, the PID is unknown, or the participant has not yet reached the
 * task — the live view then renders "task not started".
 *
 * NOTE: no `ANCHOR_CORRECTION_MS` is applied here. That +2 s correction is a
 * recording-anchor concern (Task 4, set on `cb_sessions.recording_started_at`);
 * the live clock previews the raw task-start moment.
 */
export async function taskStartForPid(pid: string): Promise<string | null> {
  await requireAuthUser();
  const trimmed = (pid ?? '').trim();
  if (!trimmed) return null;

  const taskModuleId = await resolveTaskModuleId();
  if (!taskModuleId) return null;

  const sb = createServiceRoleClient();
  const userId = await resolveUserId(sb, trimmed);
  if (!userId) return null;

  // min(created_at) of the task module_start. `created_at asc, limit 1` gives
  // the earliest such event without an aggregate (PostgREST has no min()).
  const { data, error } = await sb
    .from('study_events')
    .select('created_at')
    .eq('user_id', userId)
    .eq('module_id', taskModuleId)
    .eq('event_type', 'module_start')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`taskStartForPid failed: ${error.message}`);
  return data?.created_at ?? null;
}

/**
 * The participant's TASK end time — the moment the live clock FREEZES.
 *
 * READ-ONLY. Resolves `user_id` from `users.pid`, then returns the `created_at`
 * of the participant's LATEST `study_complete` event (the finished screen), or
 * null when the PID is unknown or has not finished. The live clock stops ticking
 * once this is set and the elapsed FREEZES at `study_complete − taskStart`.
 *
 * Mirrors `taskStartForPid`'s resolve-then-select shape, but does NOT scope to
 * the task module: `study_complete` is a whole-study terminal event, so we take
 * the latest one for the user regardless of `module_id`. `created_at desc,
 * limit 1` yields the most recent without an aggregate (PostgREST has no max()).
 */
export async function taskEndedForPid(pid: string): Promise<string | null> {
  await requireAuthUser();
  const trimmed = (pid ?? '').trim();
  if (!trimmed) return null;

  const sb = createServiceRoleClient();
  const userId = await resolveUserId(sb, trimmed);
  if (!userId) return null;

  const { data, error } = await sb
    .from('study_events')
    .select('created_at')
    .eq('user_id', userId)
    .eq('event_type', 'study_complete')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`taskEndedForPid failed: ${error.message}`);
  return data?.created_at ?? null;
}

/** A task-module boundary event as the auto-episode derivation consumes it: the
 *  raw fields `deriveEpisodeMarks` reads (`eventType`, `payload`, `createdAt`).
 *  Only `module_start`/`step_advance` rows on the task module are returned. */
export type TaskBoundaryEvent = {
  eventType: string;
  payload: Json;
  createdAt: string;
};

/**
 * The participant's ordered task-module boundary events — the input to the
 * auto-episode derivation (Task 4). READ-ONLY: resolves the `type:'task'` module
 * id (shown study `authored_data`) and `user_id` (`users.pid`), then SELECTs that
 * user's `module_start`/`step_advance` rows on the task module, ordered by
 * `created_at` ascending (chronological, the order `deriveEpisodeMarks` expects).
 * Returns [] when the study has no task module, the PID is unknown, or the
 * participant has logged no task boundaries. Every query is a `.select()`.
 */
export async function taskBoundaryEventsForPid(
  pid: string,
): Promise<TaskBoundaryEvent[]> {
  await requireAuthUser();
  const trimmed = (pid ?? '').trim();
  if (!trimmed) return [];

  const taskModuleId = await resolveTaskModuleId();
  if (!taskModuleId) return [];

  const sb = createServiceRoleClient();
  const userId = await resolveUserId(sb, trimmed);
  if (!userId) return [];

  const { data, error } = await sb
    .from('study_events')
    .select('event_type, payload, created_at')
    .eq('user_id', userId)
    .eq('module_id', taskModuleId)
    .in('event_type', ['module_start', 'step_advance'])
    .order('created_at', { ascending: true });
  if (error) throw new Error(`taskBoundaryEventsForPid failed: ${error.message}`);

  return (data ?? []).map((e) => ({
    eventType: e.event_type,
    payload: e.payload,
    createdAt: e.created_at,
  }));
}

/** The active study's authored modules, for the humanizer's `module_start`
 *  → title resolution. READ-ONLY (derived from `getShownStudy`). */
export type LiveModuleMeta = { id: string; type: string; title: string };

/**
 * The active study's modules as `{id, type, title}`, parsed from the shown
 * study's `authored_data.modules`. Used by the live view to humanize
 * `module_start` events into readable titles and to surface the task module.
 * READ-ONLY. Returns [] when there is no shown study or no parseable modules.
 */
export async function listStudyModules(): Promise<LiveModuleMeta[]> {
  await requireAuthUser();
  return parseModules(await safeShownStudyAuthoredData());
}

/** The polled live status for a PID: the humanized current step (or null when
 *  the PID has no events), the latest event's timestamp, and the task-start
 *  anchor (the clock's t=0, or null when the task hasn't started). One round
 *  trip backs the client's 3 s poll. */
export type LiveStatus = {
  /** Humanized "what they're doing now" (e.g. "Scenario 2 · revise"); null if
   *  the PID has logged no events yet. */
  stepLabel: string | null;
  /** `created_at` of the latest event (ISO), or null. */
  latestAt: string | null;
  /** The task `module_start` time (ISO), or null if the task hasn't started. */
  taskStartedAt: string | null;
  /** The `study_complete` time (ISO) when the participant reached the finished
   *  screen, or null if they haven't. When set, the live clock FREEZES at
   *  `taskEndedAt − taskStartedAt` (no ticking past finish). */
  taskEndedAt: string | null;
};

/**
 * One-shot live status for a PID — the unit the client polls every 3 s. Reads
 * the latest event + the task-start anchor + the study modules (to title the
 * `module_start` label) and returns the HUMANIZED step plus the two timestamps
 * the client needs for the clock. All READS of study tables. An empty/whitespace
 * pid yields the empty status (no step, no anchor) without touching the DB.
 */
export async function liveStatusForPid(pid: string): Promise<LiveStatus> {
  await requireAuthUser();
  const trimmed = (pid ?? '').trim();
  if (!trimmed)
    return { stepLabel: null, latestAt: null, taskStartedAt: null, taskEndedAt: null };

  const [latest, taskStartedAt, taskEndedAt, modules] = await Promise.all([
    latestEventForPid(trimmed),
    taskStartForPid(trimmed),
    taskEndedForPid(trimmed),
    listStudyModules(),
  ]);

  const stepLabel = latest
    ? humanizeEvent(
        {
          eventType: latest.eventType,
          payload: latest.payload,
          moduleId: latest.moduleId,
        },
        modules,
      )
    : null;

  return {
    stepLabel,
    latestAt: latest?.createdAt ?? null,
    taskStartedAt,
    taskEndedAt,
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Resolve a `users.id` from a `pid`. READ-ONLY. Null when the pid is unknown. */
async function resolveUserId(
  sb: ReturnType<typeof createServiceRoleClient>,
  pid: string,
): Promise<string | null> {
  const { data, error } = await sb
    .from('users')
    .select('id')
    .eq('pid', pid)
    .maybeSingle();
  if (error) throw new Error(`resolveUserId failed: ${error.message}`);
  return data?.id ?? null;
}

/** The active study's `type:'task'` module id (the recorded module), or null.
 *  READ-ONLY: derived from `getShownStudy().authored_data`. */
async function resolveTaskModuleId(): Promise<string | null> {
  const modules = parseModules(await safeShownStudyAuthoredData());
  const task = modules.find((m) => m.type === 'task');
  return task?.id ?? null;
}

/** Read the shown study's `authored_data`, tolerating its absence (null). */
async function safeShownStudyAuthoredData(): Promise<Json | null> {
  const study = await getShownStudy();
  return study?.authored_data ?? null;
}

/** Parse `authored_data.modules` into `{id, type, title}`. Defensive against a
 *  missing/oddly-shaped `authored_data`: returns [] rather than throwing, and
 *  skips any module entry lacking a string `id`/`type`. */
function parseModules(authoredData: Json | null): LiveModuleMeta[] {
  if (!authoredData || typeof authoredData !== 'object' || Array.isArray(authoredData)) {
    return [];
  }
  const modules = (authoredData as Record<string, unknown>).modules;
  if (!Array.isArray(modules)) return [];

  const out: LiveModuleMeta[] = [];
  for (const m of modules) {
    if (!m || typeof m !== 'object') continue;
    const rec = m as Record<string, unknown>;
    if (typeof rec.id !== 'string' || typeof rec.type !== 'string') continue;
    out.push({
      id: rec.id,
      type: rec.type,
      title: typeof rec.title === 'string' ? rec.title : '',
    });
  }
  return out;
}

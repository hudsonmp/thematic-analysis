'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { studyFrom } from '@/lib/supabase/study-guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getShownStudy } from '@/app/actions/codebook';
import { coerceEntity } from '@/lib/spec/reconstruct';
import { parseTaskAuthoring } from '@/lib/study/task-module';
import {
  buildSteps,
  stepCount as countSteps,
  type PhaseSnapshot,
  type ProgressionStep,
} from '@/lib/progression/progression';
import type { Requirement, Scenario } from '@/lib/study/study';

// ---------------------------------------------------------------------------
// Progression-analysis data layer (study-table READ, sub-project A).
//
// Reads the per-phase spec+entities snapshots (`study_snapshots` — one row per
// (participant, module, scenario, phase) boundary, written by the participant
// app at each phase flush) and shapes them into the 5-step progression the
// viewer renders. ALL study reads go through `studyFrom` (select-only guard on
// the user client; study tables carry SELECT-only RLS — the write-safety spec's
// L1+L2). `cb_sessions` (cohort tag) is read via the user client directly, the
// same split every study-reading action uses.
//
// PARTICIPANT-FIRST, not session-first: 27 users have snapshots but only 26
// cb_sessions exist — PIDs with a progression and NO session (343, 411) must
// still list, with cohort null (rendered "—", never defaulted).
//
// PII: `pid` only. This module never selects first_name or email.
// Empty-shape discipline: unknown pid / no snapshots → null / [] — never throw
// (only a genuine DB .error throws), mirroring spec.ts / chat.ts.
// ---------------------------------------------------------------------------

export type ProgressionParticipant = {
  pid: string;
  cohort: string | null;
  sessionId: string | null;
  stepCount: number;
};

export type ParticipantProgression = {
  pid: string;
  title: string;
  requirements: Requirement[];
  scenarios: Scenario[];
  steps: ProgressionStep[];
};

/** Snapshot row → engine shape. `entities` is ALREADY-PARSED jsonb (an array) —
 *  coerce each element; never JSON.parse (that's the event-stream encoding). */
function toPhaseSnapshot(row: {
  phase: string;
  scenario_idx: number | null;
  spec: string;
  entities: unknown;
  client_ts: string | null;
  created_at: string;
}): PhaseSnapshot | null {
  if (row.phase !== 'initial' && row.phase !== 'after_scenario' && row.phase !== 'final') {
    return null; // unknown phase: drop defensively (closed enum in the writer)
  }
  return {
    phase: row.phase,
    scenarioIdx: row.scenario_idx,
    spec: typeof row.spec === 'string' ? row.spec : '',
    entities: Array.isArray(row.entities) ? row.entities.map(coerceEntity) : [],
    clientTs: row.client_ts,
    createdAt: row.created_at,
  };
}

/**
 * Participants who have progression snapshots on the task module, ordered by
 * pid, each with cohort (via cb_sessions.pid_label = users.pid; null when no
 * session) and a filled-step count for the picker's "n/5" hint.
 */
export async function listProgressionParticipants(): Promise<ProgressionParticipant[]> {
  await requireAuthUser();

  // 1. Task module (scopes snapshots; every current snapshot is on it anyway —
  //    if unresolvable we include all rows rather than silently guessing).
  const authoring = parseTaskAuthoring((await getShownStudy())?.authored_data ?? null);

  // 2. All snapshot slots (user_id + slot keys only) via the select-only guard.
  //    Deterministic input order: makes the engine's latest-per-slot dedupe
  //    stable when two duplicate rows share an identical timestamp
  //    (`commitMs >=` keeps the last-iterated row).
  let snapQuery = (await studyFrom('study_snapshots'))
    .select('user_id, phase, scenario_idx, client_ts, created_at')
    .order('client_ts', { ascending: true });
  if (authoring) snapQuery = snapQuery.eq('module_id', authoring.moduleId);
  const snapRes = await snapQuery;
  if (snapRes.error) {
    throw new Error(`listProgressionParticipants: study_snapshots read failed: ${snapRes.error.message}`);
  }
  const rows = snapRes.data ?? [];
  if (rows.length === 0) return [];

  // Group slot rows per user; spec/entities are irrelevant for counting, so
  // synthesize empty ones for the engine's stepCount.
  const byUser = new Map<string, PhaseSnapshot[]>();
  for (const r of rows) {
    const snap = toPhaseSnapshot({ ...r, spec: '', entities: [] });
    if (!snap) continue;
    const list = byUser.get(r.user_id) ?? [];
    list.push(snap);
    byUser.set(r.user_id, list);
  }

  // 3. pid per user (pid ONLY — no name/email leaves this layer).
  const userRes = await (await studyFrom('users'))
    .select('id, pid')
    .in('id', [...byUser.keys()]);
  if (userRes.error) {
    throw new Error(`listProgressionParticipants: users read failed: ${userRes.error.message}`);
  }

  // 4. Cohort via cb_sessions (user client — cb_ table), keyed by pid_label.
  //    LEFT-join semantics: a pid with no session keeps cohort null.
  const userSb = await createUserServerClient();
  const sessRes = await userSb.from('cb_sessions').select('id, pid_label, collection');
  if (sessRes.error) {
    throw new Error(`listProgressionParticipants: cb_sessions read failed: ${sessRes.error.message}`);
  }
  const sessionByPid = new Map<string, { id: string; collection: string }>();
  for (const s of sessRes.data ?? []) {
    const pid = (s.pid_label ?? '').trim();
    if (pid && !sessionByPid.has(pid)) sessionByPid.set(pid, { id: s.id, collection: s.collection });
  }

  return (userRes.data ?? [])
    .map((u) => {
      const sess = sessionByPid.get(u.pid) ?? null;
      return {
        pid: u.pid,
        cohort: sess?.collection ?? null,
        sessionId: sess?.id ?? null,
        stepCount: countSteps(byUser.get(u.id) ?? []),
      };
    })
    .sort((a, b) => a.pid.localeCompare(b.pid));
}

/**
 * One participant's full progression: authored requirements + scenarios (for
 * the right-hand pane) and the 5 steps with snapshots + entity diffs. Null when
 * the pid is unknown or has no snapshots (the picker only lists pids that do,
 * so null here means a stale/removed pid — the UI shows an empty state).
 */
export async function getParticipantProgression(pid: string): Promise<ParticipantProgression | null> {
  await requireAuthUser();
  const cleanPid = (pid ?? '').trim();
  if (!cleanPid) return null;

  const authoring = parseTaskAuthoring((await getShownStudy())?.authored_data ?? null);

  const userRes = await (await studyFrom('users'))
    .select('id')
    .eq('pid', cleanPid)
    .maybeSingle();
  if (userRes.error) {
    throw new Error(`getParticipantProgression: users read failed: ${userRes.error.message}`);
  }
  const userId = userRes.data?.id;
  if (!userId) return null;

  // Deterministic input order for the same dedupe-stability reason as above.
  let snapQuery = (await studyFrom('study_snapshots'))
    .select('phase, scenario_idx, spec, entities, client_ts, created_at')
    .eq('user_id', userId)
    .order('client_ts', { ascending: true });
  if (authoring) snapQuery = snapQuery.eq('module_id', authoring.moduleId);
  const snapRes = await snapQuery;
  if (snapRes.error) {
    throw new Error(`getParticipantProgression: study_snapshots read failed: ${snapRes.error.message}`);
  }

  const snapshots = (snapRes.data ?? [])
    .map(toPhaseSnapshot)
    .filter((s): s is PhaseSnapshot => s !== null);
  if (snapshots.length === 0) return null;

  return {
    pid: cleanPid,
    title: authoring?.title ?? '',
    requirements: authoring?.requirements ?? [],
    scenarios: authoring?.scenarios ?? [],
    steps: buildSteps(snapshots),
  };
}

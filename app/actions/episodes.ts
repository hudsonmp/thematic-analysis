'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getOrCreateCodebook } from '@/app/actions/codebook';
import { taskBoundaryEventsForPid, taskStartForPid } from '@/app/actions/live';
import { getRecordingStart } from '@/app/actions/recording';
import { listObservationsForPid } from '@/app/actions/observations';
import {
  deriveEpisodeMarks,
  type CanonicalStep,
} from '@/lib/live/episodes-from-events';
import type { Tables } from '@/lib/types/cb-db';

type Episode = Tables<'cb_episodes'>;

// ---------------------------------------------------------------------------
// Preset episodes (codebook-scoped)
//
// An "episode" is a named, meaningful chunk of a study session (e.g.
// "Scenario 1 read", "revise", a custom phase). The researcher curates a PRESET
// list of these once per codebook — exactly like the facet editor — then, while
// coding a session, MARKS where an episode starts at the current video timecode
// (see the session-episode marks below). Writes go through `cbFrom` (service
// role; cb_episodes' RLS is open to `authenticated`), mirroring facets.ts.
// ---------------------------------------------------------------------------

/**
 * List a codebook's preset episodes in display order (`position`, then
 * `created_at` as a stable tiebreak for rows that share a position). Returns the
 * full rows so the manager UI can show name + description.
 */
export async function listEpisodes(codebookId: string): Promise<Episode[]> {
  await requireAuthUser();
  const { data, error } = await cbFrom('cb_episodes')
    .select('*')
    .eq('codebook_id', codebookId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listEpisodes failed: ${error.message}`);
  return data ?? [];
}

/**
 * Create a preset episode under a codebook. `position` is appended after the
 * current max so a new episode lands at the end of the ordered list. Returns the
 * inserted row.
 */
export async function createEpisode(
  codebookId: string,
  { name, description }: { name: string; description?: string },
): Promise<Episode> {
  await requireAuthUser();
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('createEpisode: name is required.');

  const position = await nextPosition(codebookId);
  const { data, error } = await cbFrom('cb_episodes')
    .insert({
      codebook_id: codebookId,
      name: trimmed,
      description: description?.trim() || null,
      position,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`createEpisode failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Rename (and optionally re-describe) a preset episode. `description` is only
 * patched when explicitly provided; passing an empty string clears it.
 */
export async function renameEpisode(
  id: string,
  { name, description }: { name: string; description?: string },
): Promise<Episode> {
  await requireAuthUser();
  const patch: { name?: string; description?: string | null } = {};
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('renameEpisode: name cannot be empty.');
    patch.name = trimmed;
  }
  if (description !== undefined) patch.description = description.trim() || null;

  const { data, error } = await cbFrom('cb_episodes')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`renameEpisode failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * Delete a preset episode. Its session marks cascade
 * (cb_session_episodes.episode_id FK on delete cascade).
 */
export async function deleteEpisode(id: string): Promise<void> {
  await requireAuthUser();
  const { error } = await cbFrom('cb_episodes').delete().eq('id', id);
  if (error) throw new Error(`deleteEpisode failed: ${error.message}`);
}

/**
 * Set `position` = array index for each episode id, in the given order. Issued
 * as independent updates (Supabase has no single-statement bulk-reorder) and
 * awaited together; throws on the first error. Mirrors `reorderFacets`.
 */
export async function reorderEpisodes(orderedIds: string[]): Promise<void> {
  await requireAuthUser();
  const results = await Promise.all(
    orderedIds.map((id, index) =>
      cbFrom('cb_episodes').update({ position: index }).eq('id', id),
    ),
  );
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) throw new Error(`reorderEpisodes failed: ${firstError.message}`);
}

// ---------------------------------------------------------------------------
// Session-episode marks (per-session, at a video timecode)
//
// A MARK pins a preset episode to a moment in a session: "episode X starts at
// t_start_ms in this session". While coding, the coder picks a preset episode
// and marks the current video time; the player then lists these as navigable
// boundaries to seek/resume from. Writes route through the user client so
// `marked_by = auth.uid()` and RLS (write open to `authenticated`) admits them.
// ---------------------------------------------------------------------------

/** A session-episode mark as the player consumes it (joined to its episode name). */
export type SessionEpisodeView = {
  id: string;
  episodeId: string;
  episodeName: string;
  tStartMs: number;
  tEndMs: number | null;
};

/**
 * Mark a preset episode at a video timecode in a session. `marked_by` is set
 * explicitly to the signed-in user's uid (it records who placed the mark).
 * `tEndMs` is optional — SP marks a START point; a span can be closed later.
 * Returns the inserted row.
 */
export async function markSessionEpisode({
  sessionId,
  episodeId,
  tStartMs,
  tEndMs,
}: {
  sessionId: string;
  episodeId: string;
  tStartMs: number;
  tEndMs?: number | null;
}): Promise<Tables<'cb_session_episodes'>> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_session_episodes')
    .insert({
      session_id: sessionId,
      episode_id: episodeId,
      t_start_ms: Math.max(0, Math.round(tStartMs)),
      t_end_ms: tEndMs == null ? null : Math.round(tEndMs),
      marked_by: user.id,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`markSessionEpisode failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

/**
 * List a session's episode marks, joined to the preset episode's name, ordered
 * by `t_start_ms` so the timeline reads in playback order. Reads through the
 * user client (the read policy admits `authenticated`).
 */
export async function listSessionEpisodes(
  sessionId: string,
): Promise<SessionEpisodeView[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_session_episodes')
    .select('id, episode_id, t_start_ms, t_end_ms, cb_episodes(name)')
    .eq('session_id', sessionId)
    .order('t_start_ms', { ascending: true });
  if (error) {
    throw new Error(`listSessionEpisodes failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    id: string;
    episode_id: string;
    t_start_ms: number;
    t_end_ms: number | null;
    cb_episodes: { name: string } | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    episodeId: r.episode_id,
    // Fall back if the preset was deleted out from under a mark (FK cascades, so
    // this is defensive — a live mark always has its episode).
    episodeName: r.cb_episodes?.name ?? '(deleted episode)',
    tStartMs: r.t_start_ms,
    tEndMs: r.t_end_ms,
  }));
}

/**
 * Delete a session-episode mark by id. RLS admits `authenticated`; a missing id
 * matches zero rows (silent no-op), not an error.
 */
export async function deleteSessionEpisode(id: string): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_session_episodes').delete().eq('id', id);
  if (error) throw new Error(`deleteSessionEpisode failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Auto-materialized episodes (from the participant event stream) — Task 4 of the
// live co-observation feature.
//
// At recording-link time, the participant's task `study_events` boundaries
// (module_start / step_advance) are derived into canonical phases and
// MATERIALIZED as `cb_session_episodes` marks, so the read→ponder→revise structure
// sits on the recording timeline beside the researcher's own marks — with no hand
// scrubbing. The researcher OWNS episodes: each canonical phase is mapped onto an
// EXISTING `cb_episodes` preset by a CASE-INSENSITIVE name match; a preset is
// auto-created ONLY when none matches (the researcher may then rename/merge it).
//
// READ-ONLY on study tables: events come from `live.ts:taskBoundaryEventsForPid`
// (selects on users/studies/study_events). The WRITES are cb_ only — cb_episodes
// (auto-create) via `cbFrom`, cb_session_episodes (the marks) via the user client.
// ---------------------------------------------------------------------------

/** The display name each canonical phase resolves to. These match the researcher's
 *  EIGHT existing `cb_episodes` presets EXACTLY (case-insensitively), so a derived
 *  phase reuses the real preset instead of auto-creating a duplicate. */
const CANONICAL_EPISODE_NAME: Record<CanonicalStep, string> = {
  requirements: 'Requirements Analysis',
  specification: 'Writing Specification from Requirements',
  scenario: 'New Scenario Introduced',
  editing: 'Editing Specification',
  scenario_retro: 'Scenario Retrospective',
  general_retro_1: 'General Retrospective Question I',
  general_retro_2: 'General Retrospective Question II',
  general_retro_3: 'General Retrospective Question III',
};

/**
 * Derive the participant's task episodes from `study_events` and materialize them
 * as `cb_session_episodes` marks for the session.
 *
 * PREFERS the session's manual `recording_started_at` anchor, but does NOT require
 * it: when unset (no "Start recording" mark), it FALLS BACK to the participant's
 * task-start anchor (`taskStartForPid` → earliest task `module_start`), so the
 * auto-episodes still materialize on a sensible relative clock. Steps:
 *   1. Load the session (`pid_label`, `recording_started_at`). Anchor: use
 *      `recording_started_at` if set, else the task `module_start`; if neither
 *      resolves to a parseable instant, return [] (no throw).
 *   2. `taskBoundaryEventsForPid(pid)` (READ-ONLY) → ordered boundary events.
 *   3. `deriveEpisodeMarks(events, anchorMs)` → canonical marks (clamped/deduped).
 *   4. Resolve the bound codebook (`getOrCreateCodebook`) and its existing episode
 *      presets; map each mark's `stepLabel` → `episode_id` by case-insensitive
 *      NAME match, auto-creating a preset only when none matches.
 *   5. Insert each mark — IDEMPOTENTLY: keyed on `(session_id, episode_id,
 *      t_start_ms)`, an existing identical triple is skipped, so re-running never
 *      duplicates a mark (and never disturbs a researcher's manual mark at another
 *      timestamp). Auto-created presets are deduped within this run too, so a
 *      phase that recurs maps to one preset, not many.
 *
 * Returns the marks that now exist for the session's auto-derived phases (the
 * full derived set, whether freshly inserted or already present).
 */
export async function materializeAutoEpisodes(
  sessionId: string,
): Promise<SessionEpisodeView[]> {
  const user = await requireAuthUser();
  const id = (sessionId ?? '').trim();
  if (!id) throw new Error('materializeAutoEpisodes: sessionId is required.');

  const sb = await createUserServerClient();

  // 1. Session: need the PID and the anchor.
  const { data: session, error: sessErr } = await sb
    .from('cb_sessions')
    .select('id, pid_label, recording_started_at')
    .eq('id', id)
    .maybeSingle();
  if (sessErr) {
    throw new Error(`materializeAutoEpisodes: cb_sessions select failed: ${sessErr.message}`);
  }
  if (!session) throw new Error(`materializeAutoEpisodes: session ${id} not found.`);

  const pidLabel = (session.pid_label ?? '').trim();
  if (!pidLabel) {
    throw new Error('materializeAutoEpisodes: session has no pid_label.');
  }

  // Anchor (MUST match the page's flag anchor so episodes + flags share ONE clock):
  // PREFER the manual "Start recording" mark (cb_recording_marks via
  // getRecordingStart), then the session's recording_started_at column, then FALL
  // BACK to the participant's task start (earliest task `module_start`). An
  // unparseable or missing anchor yields [] rather than a throw — without a clock
  // there is nothing to project the marks onto. See app/(protected)/sessions/[id]/
  // page.tsx, which resolves the same precedence for the flag rail.
  const anchorIso =
    (await getRecordingStart(pidLabel)) ??
    session.recording_started_at ??
    (await taskStartForPid(pidLabel));
  if (!anchorIso) return [];
  const anchorMs = Date.parse(anchorIso);
  if (Number.isNaN(anchorMs)) return [];

  // 2-3. READ-ONLY study reads → derive canonical marks.
  const events = await taskBoundaryEventsForPid(pidLabel);
  const marks = deriveEpisodeMarks(
    events.map((e) => ({
      eventType: e.eventType,
      payload: e.payload,
      createdAt: e.createdAt,
    })),
    anchorMs,
  );
  if (marks.length === 0) return [];

  // 4. Codebook + its existing presets → step→episode_id resolver.
  const codebook = await getOrCreateCodebook();
  const resolveEpisodeId = await buildEpisodeResolver(codebook.id);

  // 5. Existing marks for this session (idempotency key set) — read once.
  const { data: existingRows, error: existErr } = await sb
    .from('cb_session_episodes')
    .select('episode_id, t_start_ms')
    .eq('session_id', id);
  if (existErr) {
    throw new Error(
      `materializeAutoEpisodes: existing marks select failed: ${existErr.message}`,
    );
  }
  const existingKeys = new Set(
    (existingRows ?? []).map((r) => markKey(r.episode_id, r.t_start_ms)),
  );

  // Insert each derived mark. The `existingKeys` set is a fast-path skip, but the
  // REAL idempotency guarantee is the DB UNIQUE(session_id, episode_id, t_start_ms)
  // constraint (migration 28): because this runs automatically on every page load,
  // concurrent/repeated loads would otherwise race the read-then-insert and
  // duplicate every mark. `upsert(..., ignoreDuplicates)` turns a colliding triple
  // into a no-op instead of a duplicate row (or an error). Episode-id resolution
  // caches/creates per canonical phase, so a recurring phase maps to ONE preset.
  for (const mark of marks) {
    const episodeId = await resolveEpisodeId(mark.stepLabel);
    const key = markKey(episodeId, mark.tStartMs);
    if (existingKeys.has(key)) continue; // fast-path: skip a triple we already saw
    existingKeys.add(key);

    const { error: insErr } = await sb.from('cb_session_episodes').upsert(
      {
        session_id: id,
        episode_id: episodeId,
        t_start_ms: mark.tStartMs,
        marked_by: user.id,
      },
      { onConflict: 'session_id,episode_id,t_start_ms', ignoreDuplicates: true },
    );
    if (insErr) {
      throw new Error(
        `materializeAutoEpisodes: cb_session_episodes upsert failed: ${insErr.message}`,
      );
    }
  }

  // 6. MANUAL event-marks: observations the researcher tapped live carrying an
  //    episode_id materialize into cb_session_episodes too, at the SAME relative
  //    clock (created_at − recording_started_at). So a live phase-mark lands on
  //    the review timeline beside the auto-derived ones (the two coexist; we do
  //    NOT dedupe a manual mark against an auto mark at a different timestamp).
  //    Idempotent against the SAME (episode_id, t_start_ms) triple — the existing
  //    key set already absorbs prior runs (auto + manual).
  await materializeManualMarks(sb, id, pidLabel, anchorMs, existingKeys, user.id);

  // Return the session's marks (auto-derived + manual, joined to episode names).
  return listSessionEpisodes(id);
}

/**
 * Project a participant's MANUAL live event-marks (observations carrying an
 * `episode_id`) onto a session's relative clock as `cb_session_episodes` marks.
 *
 * Each such observation pins a preset episode at an ABSOLUTE moment
 * (`created_at`); its session offset is `created_at − recording_started_at`
 * (clamped at 0). Inserts each at that `t_start_ms` for the existing `episode_id`,
 * IDEMPOTENTLY: keyed on `(session_id, episode_id, t_start_ms)` via `existingKeys`
 * (shared with the auto path), so re-running never duplicates a mark and an
 * identical auto+manual triple collapses to one. `existingKeys` is mutated so a
 * later call in the same run also sees these.
 *
 * Marks route through the user client (`marked_by = auth.uid()`); cb_ writes only.
 */
async function materializeManualMarks(
  sb: Awaited<ReturnType<typeof createUserServerClient>>,
  sessionId: string,
  pidLabel: string,
  anchorMs: number,
  existingKeys: Set<string>,
  userId: string,
): Promise<void> {
  // The participant's observations (read-all RLS); keep only event-marks.
  const observations = await listObservationsForPid(pidLabel);
  const eventMarks = observations.filter((o) => o.episodeId !== null);

  for (const obs of eventMarks) {
    const createdMs = Date.parse(obs.createdAt);
    if (Number.isNaN(createdMs)) continue; // unparseable created_at: skip, not fatal
    const tStartMs = Math.max(0, Math.round(createdMs - anchorMs));
    const episodeId = obs.episodeId as string;

    const key = markKey(episodeId, tStartMs);
    if (existingKeys.has(key)) continue; // idempotent: skip an identical triple
    existingKeys.add(key);

    const { error: insErr } = await sb.from('cb_session_episodes').upsert(
      {
        session_id: sessionId,
        episode_id: episodeId,
        t_start_ms: tStartMs,
        marked_by: userId,
      },
      { onConflict: 'session_id,episode_id,t_start_ms', ignoreDuplicates: true },
    );
    if (insErr) {
      throw new Error(
        `materializeAutoEpisodes: manual mark upsert failed: ${insErr.message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** The idempotency key for an auto-mark: `(episode_id, t_start_ms)` within a
 *  session. Re-running materialization skips any triple already present. */
function markKey(episodeId: string, tStartMs: number): string {
  return `${episodeId}::${tStartMs}`;
}

/**
 * Build a `stepLabel → episode_id` resolver for a codebook: case-insensitively
 * matches a canonical phase's display name against the codebook's EXISTING
 * `cb_episodes` presets, and auto-creates a preset (once) when none matches. The
 * returned closure caches resolutions so repeated phases reuse the same id and a
 * single auto-create happens per phase within a run.
 */
async function buildEpisodeResolver(
  codebookId: string,
): Promise<(step: CanonicalStep) => Promise<string>> {
  const presets = await listEpisodes(codebookId);
  // Case-insensitive name → id index of existing presets.
  const byName = new Map<string, string>();
  for (const p of presets) byName.set(p.name.trim().toLowerCase(), p.id);
  // Per-run cache (also absorbs just-auto-created presets).
  const cache = new Map<CanonicalStep, string>();

  return async (step: CanonicalStep): Promise<string> => {
    const cached = cache.get(step);
    if (cached) return cached;

    const name = CANONICAL_EPISODE_NAME[step];
    const matchId = byName.get(name.trim().toLowerCase());
    if (matchId) {
      cache.set(step, matchId);
      return matchId;
    }

    // No matching preset → auto-create one (the researcher may rename/merge it).
    const created = await createEpisode(codebookId, { name });
    byName.set(name.trim().toLowerCase(), created.id);
    cache.set(step, created.id);
    return created.id;
  };
}

/**
 * Compute the next append position for a preset episode: (max existing position
 * within the codebook) + 1, or 0 if none exist. Mirrors facets.ts `nextPosition`.
 */
async function nextPosition(codebookId: string): Promise<number> {
  const { data, error } = await cbFrom('cb_episodes')
    .select('position')
    .eq('codebook_id', codebookId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`nextPosition(cb_episodes) failed: ${error.message}`);
  return data ? data.position + 1 : 0;
}

'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
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
// Internal
// ---------------------------------------------------------------------------

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

'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';

// ---------------------------------------------------------------------------
// Manual recording-start marks (per-participant) — the PRIMARY anchor.
//
// The researcher hits "▶ Start recording" at the exact moment they start the Zoom
// recording; we capture that instant as `cb_recording_marks.started_at` (one row
// per pid, the pid is the PK — migration 24). The upload anchor path
// (autoAnchorSession) then prefers this manual mark over the auto `task
// module_start + ANCHOR_CORRECTION_MS` derivation: the click already IS the record
// start, so it is used EXACTLY (no +2 s correction). Auto is the fallback when no
// manual mark exists.
//
// `marked_by` records who placed the mark, so these route through the user client
// (`createUserServerClient`, the anon key bound to the researcher's JWT) and
// `marked_by` is set explicitly to `auth.uid()`. cb_recording_marks' RLS is open
// to `authenticated` (cb_rm_all). cb_ writes only — study tables are never touched.
// ---------------------------------------------------------------------------

/**
 * Mark the recording start for a participant at NOW. Upserts the 1:1 row on its
 * `pid` PK: the first click inserts, and re-hitting "Start recording" RESETS the
 * mark (overwrites `started_at` with the new `now()`) — a mis-click is corrected
 * by clicking again. `marked_by` is set explicitly to the signed-in user's uid.
 * Returns the persisted `started_at` (ISO) so the live clock can count from it.
 */
export async function markRecordingStart(pid: string): Promise<{ startedAt: string }> {
  const user = await requireAuthUser();
  const trimmed = (pid ?? '').trim();
  if (!trimmed) throw new Error('markRecordingStart: pid is required.');

  const startedAt = new Date().toISOString();
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_recording_marks')
    .upsert(
      { pid: trimmed, started_at: startedAt, marked_by: user.id },
      { onConflict: 'pid' },
    )
    .select('started_at')
    .single();
  if (error || !data) {
    throw new Error(`markRecordingStart failed: ${error?.message ?? 'no row returned'}`);
  }
  return { startedAt: data.started_at };
}

/**
 * Read a participant's manual recording-start instant (ISO), or null when no
 * mark has been placed (then the clock/anchor falls back to the auto task-start
 * behavior). An empty/whitespace pid yields null without touching the DB.
 */
export async function getRecordingStart(pid: string): Promise<string | null> {
  await requireAuthUser();
  const trimmed = (pid ?? '').trim();
  if (!trimmed) return null;

  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_recording_marks')
    .select('started_at')
    .eq('pid', trimmed)
    .maybeSingle();
  if (error) throw new Error(`getRecordingStart failed: ${error.message}`);
  return data?.started_at ?? null;
}

/**
 * Clear a participant's manual recording-start mark (for a mis-click). After this
 * the anchor path reverts to the auto `task module_start + ANCHOR_CORRECTION_MS`
 * fallback. A missing mark matches zero rows (silent no-op), not an error.
 */
export async function clearRecordingStart(pid: string): Promise<void> {
  await requireAuthUser();
  const trimmed = (pid ?? '').trim();
  if (!trimmed) return;

  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_recording_marks').delete().eq('pid', trimmed);
  if (error) throw new Error(`clearRecordingStart failed: ${error.message}`);
}

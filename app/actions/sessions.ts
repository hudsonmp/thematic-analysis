'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { parseSrt } from '@/lib/transcript/srt';

/**
 * Ingest a single uploaded Zoom-folder session into Postgres.
 *
 * The media objects are already in Storage by the time this runs — the browser
 * uploads them under `recordings/<sessionId>/...` BEFORE calling this action, so
 * the row can carry the (known) paths. We pass `sessionId` in (a client-generated
 * uuid) precisely so the media path is computable before any row exists.
 *
 * This runs through `createUserServerClient()` (the anon key bound to the
 * researcher's JWT), so `auth.uid()` is the signed-in user and the cb_ RLS
 * policies (`authenticated` read/write) admit the writes. `created_by` is set
 * explicitly to that uid. Study tables are never touched.
 *
 * Three writes, in order (each FK-anchored to the previous):
 *   1. `cb_sessions`            — id = sessionId, the media/srt paths, duration,
 *                                 and an inferred `track_mode`.
 *   2. `cb_transcript_versions` — the `kind:'original'` verbatim ASR version.
 *   3. `cb_segments`            — one row per parsed SRT block (bulk insert),
 *                                 anchored to that version.
 *
 * On a partial failure we best-effort delete the session row; `cb_segments` and
 * `cb_transcript_versions` cascade on `cb_sessions` delete, so that unwinds the
 * whole tree rather than leaving a half-ingested session.
 */
export async function createSessionFromUpload({
  sessionId,
  pidLabel,
  collection,
  srtText,
  videoPath,
  audioPath,
  srtPath,
  recordingStartedAt,
}: {
  sessionId: string;
  pidLabel: string;
  collection: string;
  srtText: string;
  videoPath: string | null;
  audioPath: string | null;
  srtPath: string | null;
  recordingStartedAt?: string | null;
}): Promise<{ sessionId: string; segmentCount: number }> {
  // --- Validate inputs. The SRT is mandatory: it is the transcript the whole
  //     coding workflow keys off of, and an empty parse would silently create a
  //     session with no segments. Everything else may legitimately be absent
  //     (audio-only sessions, a session whose media upload was skipped, etc.).
  const id = (sessionId ?? '').trim();
  if (!id) throw new Error('createSessionFromUpload: sessionId is required.');

  const pid = (pidLabel ?? '').trim();
  if (!pid) throw new Error('createSessionFromUpload: pidLabel is required.');

  const coll = (collection ?? '').trim() || 'uncategorized';

  if (typeof srtText !== 'string' || srtText.trim() === '') {
    throw new Error('createSessionFromUpload: srtText is required (missing SRT).');
  }

  const segments = parseSrt(srtText);
  if (segments.length === 0) {
    throw new Error(
      'createSessionFromUpload: SRT parsed to zero segments — refusing to create an empty session.',
    );
  }

  // duration = the end of the last parsed segment (input order is preserved by
  // parseSrt; the last block is the latest-ending one for single-track Zoom SRTs).
  const durationMs = segments[segments.length - 1].endMs;

  // track_mode: 'multi' if ANY parsed segment resolved a speaker label, else
  // 'single'. parseSrt's per-file majority vote already nulls speakers on a
  // single-track file, so a non-null speaker here means the file is multi-track.
  const trackMode = segments.some((s) => s.speaker !== null) ? 'multi' : 'single';

  const user = await requireAuthUser();
  const sb = await createUserServerClient();

  // --- 1. cb_sessions (id = the client-generated uuid). ---------------------
  const sessionRes = await sb
    .from('cb_sessions')
    .insert({
      id,
      pid_label: pid,
      collection: coll,
      track_mode: trackMode,
      video_path: videoPath ?? null,
      audio_path: audioPath ?? null,
      srt_path: srtPath ?? null,
      duration_ms: durationMs,
      recording_started_at: recordingStartedAt ?? null,
      created_by: user.id,
    })
    .select('id')
    .single();
  if (sessionRes.error || !sessionRes.data) {
    throw new Error(
      `createSessionFromUpload: cb_sessions insert failed: ${sessionRes.error?.message ?? 'no row returned'}`,
    );
  }

  // --- 2. cb_transcript_versions (the 'original' verbatim ASR version). -----
  const versionRes = await sb
    .from('cb_transcript_versions')
    .insert({
      session_id: id,
      kind: 'original',
      asr_engine: 'whisper',
      is_verbatim: true,
    })
    .select('id')
    .single();
  if (versionRes.error || !versionRes.data) {
    // Unwind: drop the session (segments/versions cascade on delete).
    await sb.from('cb_sessions').delete().eq('id', id);
    throw new Error(
      `createSessionFromUpload: cb_transcript_versions insert failed: ${versionRes.error?.message ?? 'no row returned'}`,
    );
  }
  const versionId = versionRes.data.id;

  // --- 3. cb_segments (bulk insert; ordinal by parse index). ----------------
  const segmentRows = segments.map((seg, i) => ({
    session_id: id,
    version_id: versionId,
    speaker: seg.speaker,
    t_start_ms: seg.startMs,
    t_end_ms: seg.endMs,
    text: seg.text,
    ordinal: i,
    source: 'acoustic' as const,
  }));

  const segmentsRes = await sb.from('cb_segments').insert(segmentRows);
  if (segmentsRes.error) {
    // Unwind the whole session tree on a failed segment write.
    await sb.from('cb_sessions').delete().eq('id', id);
    throw new Error(
      `createSessionFromUpload: cb_segments insert failed: ${segmentsRes.error.message}`,
    );
  }

  return { sessionId: id, segmentCount: segments.length };
}

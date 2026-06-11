'use server';

import { notFound } from 'next/navigation';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { parseSrt, type Segment } from '@/lib/transcript/srt';

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

/** A session index row for the `/sessions` list. */
export type SessionListRow = {
  id: string;
  pidLabel: string;
  collection: string;
  durationMs: number | null;
  trackMode: string;
};

/**
 * List all cloud sessions for the index, ordered by collection then created_at.
 *
 * Reads through `createUserServerClient()` (the researcher's JWT), so the
 * `authenticated` RLS read policy on `cb_sessions` admits the select. Returns
 * the minimal shape the index needs — annotation counts come after Task 8.
 */
export async function listSessionsCloud(): Promise<SessionListRow[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_sessions')
    .select('id, pid_label, collection, duration_ms, track_mode')
    .order('collection', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    throw new Error(`listSessionsCloud: cb_sessions select failed: ${error.message}`);
  }

  return (data ?? []).map((r) => ({
    id: r.id,
    pidLabel: r.pid_label,
    collection: r.collection,
    durationMs: r.duration_ms,
    trackMode: r.track_mode,
  }));
}

/**
 * A cloud segment is the pure-parser `Segment` plus the real `cb_segments.id`.
 * Annotations anchor to that DB id (it is the `segment_id` FK), so the player
 * needs it on every row — `Segment` (the SRT-parser shape) carries only `idx`,
 * the in-file ordinal, which is NOT a stable DB key.
 */
export type CloudSegment = Segment & { id: string };

/** A loaded cloud session: the row's display fields + its original segments. */
export type SessionDetailCloud = {
  id: string;
  pidLabel: string;
  collection: string;
  durationMs: number | null;
  trackMode: string;
  /** The original verbatim version id — annotations anchor to it (version_id). */
  versionId: string | null;
  segments: CloudSegment[];
};

/**
 * Load one cloud session by id: the `cb_sessions` row plus its `cb_segments`
 * (the original `cb_transcript_versions`), ordered by `ordinal`, mapped into the
 * `Segment` shape `SessionPlayer` already consumes (t_start_ms→startMs, etc.).
 *
 * `notFound()` (→ 404) if the session is absent. Reads through the user client;
 * the `authenticated` RLS read policies admit the selects.
 */
export async function getSessionCloud(id: string): Promise<SessionDetailCloud> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const { data: session, error: sessErr } = await sb
    .from('cb_sessions')
    .select('id, pid_label, collection, duration_ms, track_mode')
    .eq('id', id)
    .maybeSingle();
  if (sessErr) {
    throw new Error(`getSessionCloud: cb_sessions select failed: ${sessErr.message}`);
  }
  if (!session) {
    notFound();
  }

  // The original verbatim version anchors the displayed transcript.
  const { data: version, error: verErr } = await sb
    .from('cb_transcript_versions')
    .select('id')
    .eq('session_id', id)
    .eq('kind', 'original')
    .maybeSingle();
  if (verErr) {
    throw new Error(
      `getSessionCloud: cb_transcript_versions select failed: ${verErr.message}`,
    );
  }

  // Pull this version's segments in display order. No original version (a
  // pathological half-ingested session) → an empty transcript, not a crash.
  // We select the real `cb_segments.id` so each row carries the DB key that
  // annotations anchor to (segment_id), not just the in-file `ordinal`.
  let segments: CloudSegment[] = [];
  if (version) {
    const { data: rows, error: segErr } = await sb
      .from('cb_segments')
      .select('id, speaker, t_start_ms, t_end_ms, text, ordinal')
      .eq('version_id', version.id)
      .order('ordinal', { ascending: true });
    if (segErr) {
      throw new Error(`getSessionCloud: cb_segments select failed: ${segErr.message}`);
    }
    segments = (rows ?? []).map((r) => ({
      id: r.id,
      idx: r.ordinal,
      startMs: r.t_start_ms,
      endMs: r.t_end_ms,
      speaker: r.speaker,
      text: r.text,
    }));
  }

  return {
    id: session.id,
    pidLabel: session.pid_label,
    collection: session.collection,
    durationMs: session.duration_ms,
    trackMode: session.track_mode,
    versionId: version?.id ?? null,
    segments,
  };
}

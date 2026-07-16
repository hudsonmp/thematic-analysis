'use server';

import { notFound } from 'next/navigation';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { parseSrt, type Segment } from '@/lib/transcript/srt';
import { orderByTime } from '@/lib/transcript/order';
import {
  anonymizeSpeaker,
  seededResearcherKeys,
  speakerKey,
  RESEARCHER_LABEL,
} from '@/lib/transcript/anonymize';
import {
  ensureRecordingsFolder,
  createDriveResumableUpload,
} from '@/lib/google/drive';
import { taskStartForPid } from '@/app/actions/live';
import { getRecordingStart } from '@/app/actions/recording';
import { resolveRecordingAnchorMs } from '@/lib/live/anchor';
import { coderStatusFromRow, type CoderStatus } from '@/lib/codebook/sessionProgress';

/**
 * Begin a browser-direct video upload to Google Drive.
 *
 * Video lives in Drive (Supabase's free plan caps a single upload at 50MB).
 * We find-or-create the `thematic-analysis-recordings` folder and open a Drive
 * RESUMABLE upload session, returning its one-time `uploadUrl`. The BROWSER then
 * PUTs the whole video file body to that URL, so the bytes never transit our
 * server. Drive replies with the created file JSON; the browser extracts `id`
 * and passes it to `createSessionFromUpload` as `driveFileId`.
 *
 * Researcher-gated. The Drive OAuth credentials are server-only — the browser
 * only ever sees the opaque session URL.
 */
export async function startDriveVideoUpload({
  filename,
}: {
  filename: string;
}): Promise<{ uploadUrl: string }> {
  await requireAuthUser();

  const name = (filename ?? '').trim() || 'video.mp4';
  const folderId = await ensureRecordingsFolder();
  const uploadUrl = await createDriveResumableUpload(name, 'video/mp4', folderId);
  return { uploadUrl };
}

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
  driveFileId,
  videoSource,
  recordingStartedAt,
}: {
  sessionId: string;
  pidLabel: string;
  collection: string;
  srtText: string;
  videoPath: string | null;
  audioPath: string | null;
  srtPath: string | null;
  driveFileId?: string | null;
  videoSource?: 'supabase' | 'drive';
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

  // Video backend: 'drive' iff explicitly requested AND a Drive file id is
  // present; otherwise 'supabase'. Guards against a half-specified Drive upload
  // persisting a 'drive' row with no file id (which the media route can't serve).
  const driveId = (driveFileId ?? '').trim() || null;
  const resolvedVideoSource: 'supabase' | 'drive' =
    videoSource === 'drive' && driveId ? 'drive' : 'supabase';

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
      // Drive video carries no Storage path; persist the Drive file id + source.
      video_path: resolvedVideoSource === 'drive' ? null : (videoPath ?? null),
      audio_path: audioPath ?? null,
      srt_path: srtPath ?? null,
      drive_file_id: driveId,
      video_source: resolvedVideoSource,
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
  /** The SIGNED-IN coder's own progress on this session (per-coder, RLS-scoped). */
  coderStatus: CoderStatus;
  /** Session-level reconciliation flag — when set, it OVERRIDES every coder's status in
   *  the display. Null when the session is not in reconciliation. */
  reconciliationAt: string | null;
  /** The shared, per-session coordination note (any coder may edit it). */
  note: string | null;
};

/**
 * List all cloud sessions for the index, ordered by collection then created_at,
 * each flagged with whether the SIGNED-IN coder has marked it done.
 *
 * Reads through `createUserServerClient()` (the researcher's JWT), so the
 * `authenticated` RLS read policy on `cb_sessions` admits the select. The
 * per-coder done flag comes from a second read of cb_session_coding_status
 * filtered to `coder_id = user.id` (the read-all RLS would otherwise return every
 * coder's marks): we build that coder's done-set and merge it onto the rows.
 */
export async function listSessionsCloud(): Promise<SessionListRow[]> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_sessions')
    .select('id, pid_label, collection, duration_ms, track_mode, reconciliation_at, note')
    .order('collection', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    throw new Error(`listSessionsCloud: cb_sessions select failed: ${error.message}`);
  }

  // The CURRENT coder's status rows (RLS read-all returns every coder's rows, so we
  // filter to this user): the session's per-coder status is this coder's own, and
  // absence of a row is not_started.
  const { data: statusRows, error: statusErr } = await sb
    .from('cb_session_coding_status')
    .select('session_id, status')
    .eq('coder_id', user.id);
  if (statusErr) {
    throw new Error(
      `listSessionsCloud: cb_session_coding_status select failed: ${statusErr.message}`,
    );
  }
  const statusBySession = new Map<string, string>(
    (statusRows ?? []).map((r) => [r.session_id, r.status]),
  );

  return (data ?? []).map((r) => ({
    id: r.id,
    pidLabel: r.pid_label,
    collection: r.collection,
    durationMs: r.duration_ms,
    trackMode: r.track_mode,
    coderStatus: coderStatusFromRow(
      statusBySession.has(r.id) ? { status: statusBySession.get(r.id)! } : null,
    ),
    reconciliationAt: r.reconciliation_at,
    note: r.note,
  }));
}

/**
 * Mark or unmark a session as coded BY THE SIGNED-IN CODER (per-coder, binary).
 *
 * `done: true` upserts the (session, coder) row (`onConflict: 'session_id,
 * coder_id'`, `done_at` server default) — idempotent re-marking. `done: false`
 * deletes that coder's row. Both write through `createUserServerClient()` (the
 * anon key bound to the signed-in JWT, NOT the service-role client), with
 * `coder_id` set explicitly to `user.id`: the insert RLS `with check (coder_id =
 * auth.uid())` admits only the caller's own mark, and the delete RLS
 * `using (coder_id = auth.uid())` confines the unmark to the caller's own row
 * (an unmark of another coder's mark matches zero rows — silent no-op). cb_ table
 * only; no study table is touched.
 */
export async function setCoderStatus(
  sessionId: string,
  status: CoderStatus,
): Promise<void> {
  const user = await requireAuthUser();
  const id = (sessionId ?? '').trim();
  if (!id) throw new Error('setCoderStatus: sessionId is required.');

  const sb = await createUserServerClient();

  // not_started is the ABSENCE of a row, so it deletes rather than storing a sentinel.
  // The delete RLS `using (coder_id = auth.uid())` confines it to the caller's own row.
  if (status === 'not_started') {
    const { error } = await sb
      .from('cb_session_coding_status')
      .delete()
      .eq('session_id', id)
      .eq('coder_id', user.id);
    if (error) throw new Error(`setCoderStatus: reset failed: ${error.message}`);
    return;
  }

  // coder_id is set explicitly to the caller: the insert RLS `with check (coder_id =
  // auth.uid())` admits only the signed-in user's own status, so no coder can write
  // another's progress. This is where per-user isolation is ENFORCED at the DB, not
  // asserted by the app — the write goes through the JWT-bound client, not cbFrom.
  const { error } = await sb
    .from('cb_session_coding_status')
    .upsert(
      { session_id: id, coder_id: user.id, status },
      { onConflict: 'session_id,coder_id' },
    );
  if (error) throw new Error(`setCoderStatus: set failed: ${error.message}`);
}

/**
 * Toggle a session's SESSION-LEVEL reconciliation flag. This overrides every coder's
 * per-coder status in the display and is shared, not per-coder — so unlike
 * `setCoderStatus` it writes cb_sessions (the update RLS admits any authenticated
 * coder, matching the existing collection/note edits). It does nothing functional yet.
 */
export async function setReconciliation(sessionId: string, on: boolean): Promise<void> {
  await requireAuthUser();
  const id = (sessionId ?? '').trim();
  if (!id) throw new Error('setReconciliation: sessionId is required.');

  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_sessions')
    .update({ reconciliation_at: on ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) throw new Error(`setReconciliation failed: ${error.message}`);
}

/**
 * Set (or clear) a session's shared coordination NOTE. Shared, not per-coder — any
 * authenticated coder may edit it, which is the point: it is a coordination channel on
 * the session row, not a private memo. An empty note clears to NULL.
 */
export async function setSessionNote(sessionId: string, note: string): Promise<void> {
  await requireAuthUser();
  const id = (sessionId ?? '').trim();
  if (!id) throw new Error('setSessionNote: sessionId is required.');

  const sb = await createUserServerClient();
  const trimmed = note.trim();
  const { error } = await sb
    .from('cb_sessions')
    .update({ note: trimmed === '' ? null : trimmed })
    .eq('id', id);
  if (error) throw new Error(`setSessionNote failed: ${error.message}`);
}

/**
 * Reassign a session's `collection` (the index bucket + the code-authoring
 * `study_label`). Trimmed; an all-whitespace value falls back to 'uncategorized'
 * (matching the upload default) rather than persisting a blank. Writes through the
 * user client — `auth.uid()` is the researcher and the cb_ RLS write policy admits
 * the update. cb_ table only; no study table is touched.
 */
export async function updateSessionCollection(
  sessionId: string,
  collection: string,
): Promise<void> {
  await requireAuthUser();
  const id = (sessionId ?? '').trim();
  if (!id) throw new Error('updateSessionCollection: sessionId is required.');
  const coll = (collection ?? '').trim() || 'uncategorized';

  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_sessions')
    .update({ collection: coll })
    .eq('id', id);
  if (error) {
    throw new Error(`updateSessionCollection: update failed: ${error.message}`);
  }
}

/**
 * Permanently delete a session and everything anchored to it.
 *
 * A single `delete from cb_sessions where id = …` drives the whole teardown via FK
 * cascades (verified against the live schema):
 *   • cb_transcript_versions, cb_segments         — session_id CASCADE
 *   • cb_annotations (+ its cb_annotation_codes / cb_annotation_comments)
 *                                                  — session_id CASCADE (the child
 *                                                    tables cascade on annotation_id;
 *                                                    both segment anchors segment_id
 *                                                    and end_segment_id also CASCADE).
 *   • cb_session_episodes                          — session_id CASCADE
 *   • cb_observations                              — session_id SET NULL (live flags
 *                                                    intentionally OUTLIVE the session;
 *                                                    they detach rather than delete).
 *
 * Irreversible. Writes through the user client; the cb_ RLS write (delete) policy
 * admits it. cb_ tables only — no study table is touched.
 */
export async function deleteSessionCloud(sessionId: string): Promise<void> {
  await requireAuthUser();
  const id = (sessionId ?? '').trim();
  if (!id) throw new Error('deleteSessionCloud: sessionId is required.');

  const sb = await createUserServerClient();
  const { error } = await sb.from('cb_sessions').delete().eq('id', id);
  if (error) {
    throw new Error(`deleteSessionCloud: delete failed: ${error.message}`);
  }
}

/**
 * A cloud segment is the pure-parser `Segment` plus the real `cb_segments.id`.
 * Annotations anchor to that DB id (it is the `segment_id` FK), so the player
 * needs it on every row — `Segment` (the SRT-parser shape) carries only `idx`,
 * the in-file ordinal, which is NOT a stable DB key.
 */
export type CloudSegment = Segment & { id: string };

/** A loaded cloud session: the row's display fields + its active-version segments. */
export type SessionDetailCloud = {
  id: string;
  pidLabel: string;
  collection: string;
  durationMs: number | null;
  trackMode: string;
  /** The loaded version id — annotations anchor to it (version_id). */
  versionId: string | null;
  /** The loaded version's kind ('original' | 'cleaned'); null for an empty session. */
  versionKind: 'original' | 'cleaned' | null;
  /** Whether the loaded version is verbatim (the original is; cleaned is not). */
  isVerbatim: boolean;
  segments: CloudSegment[];
};

/** Map a `cb_segments` select row into the `Segment`-shape the player consumes. */
function toCloudSegment(r: {
  id: string;
  speaker: string | null;
  t_start_ms: number;
  t_end_ms: number;
  text: string;
  ordinal: number;
}): CloudSegment {
  return {
    id: r.id,
    idx: r.ordinal,
    startMs: r.t_start_ms,
    endMs: r.t_end_ms,
    speaker: r.speaker,
    text: r.text,
  };
}

type RawSegmentRow = {
  id: string;
  speaker: string | null;
  t_start_ms: number;
  t_end_ms: number;
  text: string;
  ordinal: number;
};

/**
 * Map raw cb_segments rows into `CloudSegment`s with the speaker DISPLAY label
 * anonymized: the interviewer's Zoom name → "Researcher", every other speaker →
 * the participant's PID. ONLY `speaker` is rewritten; id/ordinal/timing/text are
 * copied verbatim (annotation anchoring keys off segment text + ids, so it is
 * unaffected).
 *
 * Empty-pidLabel guard: a session with a blank `pid_label` has no participant
 * number to substitute, so we DON'T blank out participant labels (that would lose
 * the only distinguishing info). Researcher labels still collapse to "Researcher";
 * non-researcher speakers are left as their raw label. A single-track null speaker
 * stays null in every case (handled by `anonymizeSpeaker`).
 */
function anonymizeSegments(
  rows: RawSegmentRow[],
  pidLabel: string,
  researcherKeys: Set<string>,
): CloudSegment[] {
  const pid = (pidLabel ?? '').trim();
  return rows.map((r) => {
    const base = toCloudSegment(r);
    if (pid === '') {
      // No PID to map participants onto: only collapse researcher labels.
      const anon = anonymizeSpeaker(r.speaker, pid, researcherKeys);
      // anon is "Researcher" for interviewer keys, '' for other non-null speakers
      // (because pid is empty), or null for null speakers. Keep the raw label for
      // participants rather than blanking it.
      return { ...base, speaker: anon === RESEARCHER_LABEL ? RESEARCHER_LABEL : r.speaker };
    }
    return { ...base, speaker: anonymizeSpeaker(r.speaker, pid, researcherKeys) };
  });
}

/**
 * The set of normalized speaker keys treated as the interviewer/researcher:
 * the seeded interviewer aliases UNION any speaker label that recurs across
 * ≥2 distinct sessions (the interviewer appears in many sessions; each
 * participant appears in one). READ-ONLY over cb_segments.
 *
 * This is the server-side resolution of WHICH labels are the interviewer; the
 * pure mapping (`anonymizeSpeaker`) lives in lib/transcript/anonymize.ts. We do
 * it server-side so the raw Zoom display names never reach the client — only the
 * anonymized "Researcher"/PID labels are returned by the segment loaders below.
 *
 * Recurrence heuristic: select every (speaker, session_id) from cb_segments,
 * then in JS count the distinct session_ids per normalized speaker key; any key
 * seen in ≥2 distinct sessions is treated as the interviewer. Fine for the
 * current corpus; a future large corpus could push the dedupe into SQL.
 */
export async function researcherSpeakerLabels(): Promise<Set<string>> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const keys = seededResearcherKeys();

  const { data, error } = await sb
    .from('cb_segments')
    .select('speaker, session_id')
    .not('speaker', 'is', null);
  if (error) {
    throw new Error(`researcherSpeakerLabels: cb_segments select failed: ${error.message}`);
  }

  // Distinct session_ids per normalized speaker key.
  const sessionsByKey = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    if (row.speaker === null) continue;
    const key = speakerKey(row.speaker);
    if (key === '') continue;
    let set = sessionsByKey.get(key);
    if (!set) {
      set = new Set<string>();
      sessionsByKey.set(key, set);
    }
    set.add(row.session_id);
  }

  for (const [key, sessions] of sessionsByKey) {
    if (sessions.size >= 2) keys.add(key);
  }

  return keys;
}

/**
 * Load one cloud session by id and ONE of its transcript versions.
 *
 * Without `versionId` it loads the ORIGINAL (verbatim ASR) version — the default
 * the player opens on, and the behavior `getSessionCloud` had before the
 * original/cleaned split. With an explicit `versionId` it loads THAT version's
 * `cb_segments` instead (so the player can switch to the cleaned tab), after
 * verifying the version belongs to this session.
 *
 * Segments come back ordered by `ordinal`, mapped into the `Segment` shape
 * `SessionPlayer` consumes (t_start_ms→startMs, etc.), each carrying the real
 * `cb_segments.id` (the annotation `segment_id` anchor). `notFound()` (→ 404) if
 * the session is absent. Reads through the user client; the `authenticated` RLS
 * read policies admit the selects.
 */
export async function getSessionCloud(
  id: string,
  versionId?: string,
): Promise<SessionDetailCloud> {
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

  // Resolve the version to load. An explicit `versionId` selects that version
  // (verified to belong to THIS session, so a cross-session id can't be loaded);
  // otherwise we fall back to the session's ORIGINAL verbatim version.
  let version: { id: string; kind: string; is_verbatim: boolean } | null = null;
  if (versionId) {
    const { data, error } = await sb
      .from('cb_transcript_versions')
      .select('id, kind, is_verbatim')
      .eq('session_id', id)
      .eq('id', versionId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `getSessionCloud: cb_transcript_versions select failed: ${error.message}`,
      );
    }
    version = data ?? null;
  } else {
    const { data, error } = await sb
      .from('cb_transcript_versions')
      .select('id, kind, is_verbatim')
      .eq('session_id', id)
      .eq('kind', 'original')
      .maybeSingle();
    if (error) {
      throw new Error(
        `getSessionCloud: cb_transcript_versions select failed: ${error.message}`,
      );
    }
    version = data ?? null;
  }

  // Pull this version's segments in display order. No version (a pathological
  // half-ingested session, or an unknown versionId for this session) → an empty
  // transcript, not a crash. We select the real `cb_segments.id` so each row
  // carries the DB key annotations anchor to (segment_id), not just `ordinal`.
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
    // Anonymize the speaker DISPLAY label server-side: interviewer → "Researcher",
    // participant → PID. Done here so raw Zoom names never reach the client. ONLY
    // the `speaker` field changes — text/ids/timing are untouched, so annotation
    // anchoring (which keys off segment text + ids) is unaffected.
    //
    // Then order TEMPORALLY (by startMs, ties by ordinal): the SQL `ordinal` order is
    // SRT block order, which clusters a multi-track file by speaker rather than by
    // time. Reading order must follow the video so the follow-along highlight runs
    // straight down the page and interjections sit between the phrases they interrupt.
    segments = orderByTime(
      anonymizeSegments(rows ?? [], session.pid_label, await researcherSpeakerLabels()),
    );
  }

  return {
    id: session.id,
    pidLabel: session.pid_label,
    collection: session.collection,
    durationMs: session.duration_ms,
    trackMode: session.track_mode,
    versionId: version?.id ?? null,
    versionKind: (version?.kind as 'original' | 'cleaned' | undefined) ?? null,
    isVerbatim: version?.is_verbatim ?? false,
    segments,
  };
}

/** One transcript version in the session's version list (for the player's tabs). */
export type SessionVersion = {
  id: string;
  kind: 'original' | 'cleaned';
  isVerbatim: boolean;
};

/**
 * List a session's transcript versions (the player's tab set): `original` first,
 * then `cleaned`. A session always has an `original`; the `cleaned` version
 * exists only after `ensureCleanedVersion` has run. Reads through the user
 * client; the `authenticated` RLS read policy admits the select.
 */
export async function getSessionVersions(
  sessionId: string,
): Promise<SessionVersion[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await sb
    .from('cb_transcript_versions')
    .select('id, kind, is_verbatim')
    .eq('session_id', sessionId);
  if (error) {
    throw new Error(`getSessionVersions: select failed: ${error.message}`);
  }

  // Stable tab order: original before cleaned.
  const order = (k: string) => (k === 'original' ? 0 : 1);
  return (data ?? [])
    .map((r) => ({
      id: r.id,
      kind: r.kind as 'original' | 'cleaned',
      isVerbatim: r.is_verbatim,
    }))
    .sort((a, b) => order(a.kind) - order(b.kind));
}

/**
 * Load the segments for ONE version of a session (the player loads either the
 * original or the cleaned version through this). The version is verified to
 * belong to `sessionId` (so a cross-session id returns nothing rather than
 * leaking another session's transcript). Segments come back in `ordinal` order
 * in the `Segment` shape the player consumes, each carrying its real
 * `cb_segments.id`. Reads through the user client.
 */
export async function getSessionSegments(
  sessionId: string,
  versionId: string,
): Promise<CloudSegment[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  // Verify the version belongs to this session before reading its segments.
  const { data: version, error: verErr } = await sb
    .from('cb_transcript_versions')
    .select('id')
    .eq('session_id', sessionId)
    .eq('id', versionId)
    .maybeSingle();
  if (verErr) {
    throw new Error(`getSessionSegments: version select failed: ${verErr.message}`);
  }
  if (!version) return [];

  // Resolve the session's PID for participant anonymization (this loader, unlike
  // getSessionCloud, doesn't already carry the session row).
  const { data: session, error: sessErr } = await sb
    .from('cb_sessions')
    .select('pid_label')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessErr) {
    throw new Error(`getSessionSegments: cb_sessions pid_label select failed: ${sessErr.message}`);
  }

  const { data: rows, error: segErr } = await sb
    .from('cb_segments')
    .select('id, speaker, t_start_ms, t_end_ms, text, ordinal')
    .eq('version_id', versionId)
    .order('ordinal', { ascending: true });
  if (segErr) {
    throw new Error(`getSessionSegments: cb_segments select failed: ${segErr.message}`);
  }
  // Anonymize the speaker display label server-side (interviewer → "Researcher",
  // participant → PID). ONLY `speaker` changes — ids/timing/text are untouched, so
  // annotation anchoring is unaffected. Then order temporally (by startMs, ties by
  // ordinal) so the player reads in video order — see getSessionCloud for why.
  return orderByTime(
    anonymizeSegments(rows ?? [], session?.pid_label ?? '', await researcherSpeakerLabels()),
  );
}

/**
 * Ensure the session has a CLEANED transcript version, creating it (and copying
 * the original's segments into it) on first call. Idempotent.
 *
 * Methodology (Ericsson–Simon): the ORIGINAL is verbatim — disfluencies are
 * data, never auto-edited. The CLEANED version is a readable, editable copy the
 * researcher tidies for navigation and quoting; both are stored and time-aligned
 * (the copy carries the original's `t_start_ms`/`t_end_ms`/`ordinal`/`speaker`).
 *
 * If a `kind='cleaned'` version already exists this returns its id without
 * touching it (so re-running never duplicates the version or its segments). On
 * first creation:
 *   1. Resolve the session's `original` version (its id seeds
 *      `derived_from_version_id`). A session with no original is a pathological
 *      half-ingest — we refuse rather than derive a cleaned copy from nothing.
 *   2. Insert the `cleaned` version (`is_verbatim:false`, derived from original).
 *   3. Copy every original segment into the cleaned version (new `cb_segments`
 *      rows, same speaker/time/ordinal, text copied; `source:'manual'` marks the
 *      rows as a researcher-owned cleaning copy, not acoustic ASR output).
 *
 * On a failed segment copy we delete the just-created cleaned version (its
 * segments cascade) so a partial run leaves no empty cleaned version behind.
 * Writes through the user client; the `authenticated` RLS write policy admits them.
 */
export async function ensureCleanedVersion(sessionId: string): Promise<string> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  // Idempotent: a cleaned version already exists → return it untouched.
  const { data: existing, error: existErr } = await sb
    .from('cb_transcript_versions')
    .select('id')
    .eq('session_id', sessionId)
    .eq('kind', 'cleaned')
    .maybeSingle();
  if (existErr) {
    throw new Error(
      `ensureCleanedVersion: cleaned lookup failed: ${existErr.message}`,
    );
  }
  if (existing) return existing.id;

  // Resolve the original version — the cleaned copy derives from it.
  const { data: original, error: origErr } = await sb
    .from('cb_transcript_versions')
    .select('id')
    .eq('session_id', sessionId)
    .eq('kind', 'original')
    .maybeSingle();
  if (origErr) {
    throw new Error(
      `ensureCleanedVersion: original lookup failed: ${origErr.message}`,
    );
  }
  if (!original) {
    throw new Error(
      'ensureCleanedVersion: session has no original version to derive a cleaned copy from.',
    );
  }

  // Create the cleaned version (non-verbatim, derived from the original).
  const { data: created, error: createErr } = await sb
    .from('cb_transcript_versions')
    .insert({
      session_id: sessionId,
      kind: 'cleaned',
      is_verbatim: false,
      derived_from_version_id: original.id,
    })
    .select('id')
    .single();
  if (createErr || !created) {
    throw new Error(
      `ensureCleanedVersion: cleaned version insert failed: ${createErr?.message ?? 'no row returned'}`,
    );
  }
  const cleanedId = created.id;

  // Copy the original's segments into the cleaned version (time-aligned).
  const { data: origSegs, error: readErr } = await sb
    .from('cb_segments')
    .select('speaker, t_start_ms, t_end_ms, text, ordinal')
    .eq('version_id', original.id)
    .order('ordinal', { ascending: true });
  if (readErr) {
    // Unwind the just-created cleaned version (no segments to cascade yet).
    await sb.from('cb_transcript_versions').delete().eq('id', cleanedId);
    throw new Error(
      `ensureCleanedVersion: original segments read failed: ${readErr.message}`,
    );
  }

  if ((origSegs ?? []).length > 0) {
    const copyRows = (origSegs ?? []).map((s) => ({
      session_id: sessionId,
      version_id: cleanedId,
      speaker: s.speaker,
      t_start_ms: s.t_start_ms,
      t_end_ms: s.t_end_ms,
      text: s.text,
      ordinal: s.ordinal,
      // 'manual': a researcher-owned cleaning copy, not acoustic ASR output.
      source: 'manual' as const,
    }));
    const copyRes = await sb.from('cb_segments').insert(copyRows);
    if (copyRes.error) {
      // Unwind: drop the cleaned version (its copied segments cascade) so a
      // partial run never leaves a half-populated cleaned copy behind.
      await sb.from('cb_transcript_versions').delete().eq('id', cleanedId);
      throw new Error(
        `ensureCleanedVersion: segment copy failed: ${copyRes.error.message}`,
      );
    }
  }

  return cleanedId;
}

/**
 * Update one cleaned segment's text — the data-cleaning write.
 *
 * ONLY admitted on a segment whose version is `kind='cleaned'`. The ORIGINAL is
 * verbatim (Ericsson–Simon: disfluencies are data) and must NEVER be edited, so
 * we first read the segment's version and REJECT the write if it is not cleaned
 * (a missing segment is also rejected). The researcher's exact cleaned text is
 * stored as-is, but an all-whitespace edit that would blank the row is rejected
 * (`cb_segments.text` is NOT NULL and a blank segment is never a useful cleaning).
 *
 * Writes through the user client; the `authenticated` RLS write policy admits it.
 */
export async function updateSegmentText(
  segmentId: string,
  text: string,
): Promise<void> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('updateSegmentText: text must be a non-empty string.');
  }

  // Resolve the segment's version kind. The verbatim guard lives HERE (not in
  // RLS, which is true/true on these tables): refuse any edit whose version is
  // not 'cleaned'. Embed the version row to read its kind in one round-trip.
  const { data: seg, error: segErr } = await sb
    .from('cb_segments')
    .select('id, version_id, cb_transcript_versions(kind, is_verbatim)')
    .eq('id', segmentId)
    .maybeSingle();
  if (segErr) {
    throw new Error(`updateSegmentText: segment lookup failed: ${segErr.message}`);
  }
  if (!seg) {
    throw new Error('updateSegmentText: segment not found.');
  }

  const version = (
    seg as {
      cb_transcript_versions: { kind: string; is_verbatim: boolean } | null;
    }
  ).cb_transcript_versions;
  if (!version || version.kind !== 'cleaned' || version.is_verbatim) {
    throw new Error(
      'updateSegmentText: refusing to edit a verbatim/original segment — only cleaned versions are editable.',
    );
  }

  const { error: updErr } = await sb
    .from('cb_segments')
    .update({ text })
    .eq('id', segmentId);
  if (updErr) {
    throw new Error(`updateSegmentText: update failed: ${updErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Auto-anchor (recording_started_at) — Task 4 of the live co-observation feature.
//
// When a recording is linked to a session (the upload flow has set the session's
// `pid_label`), we set `recording_started_at` AUTOMATICALLY from the participant
// event stream rather than asking the researcher for a manual landmark. The
// anchor is the participant's task `module_start` time + `ANCHOR_CORRECTION_MS`
// (the +2 s record-start correction). With the anchor set, every absolute-time
// marker (analyst observations, auto-derived episodes) projects onto the
// recording's relative clock by subtraction.
//
// READ-ONLY on study tables: the task-start time comes from
// `live.ts:taskStartForPid` (a `.select()` on `users`/`studies`/`study_events`
// only). The single WRITE here is `cb_sessions.recording_started_at` (a cb_ table)
// through the user client — `auth.uid()` is the researcher and the cb_ RLS write
// policy admits it.
// ---------------------------------------------------------------------------

/** The result of an auto-anchor attempt. Discriminated on `anchored` so callers
 *  (the link/upload path, the verification harness) branch cleanly: on success,
 *  the persisted anchor (ISO); on failure, a human-readable `reason` and the
 *  session left with `recording_started_at` null (manual fallback, out of MVP). */
export type AutoAnchorResult =
  | { anchored: true; recordingStartedAt: string; pidLabel: string }
  | { anchored: false; reason: string };

/**
 * Set `cb_sessions.recording_started_at` for a session, preferring the
 * participant's MANUAL recording mark over the auto task-start derivation.
 *
 * The MANUAL mark (`cb_recording_marks.started_at`, the instant the researcher hit
 * "Start recording") is the SOURCE OF TRUTH when present — used EXACTLY, with NO
 * `ANCHOR_CORRECTION_MS` (the click already captures the real record start, so
 * there is no reaction gap to absorb). The AUTO derivation (task `module_start` +
 * `ANCHOR_CORRECTION_MS`) is the FALLBACK when no manual mark exists.
 *
 * Steps (study reads are READ-ONLY, via `taskStartForPid`; the manual mark is a
 * cb_ read via `getRecordingStart`):
 *   1. Load the session's `pid_label` (a cb_ read). Missing session → not anchored.
 *   2. In parallel: `getRecordingStart(pidLabel)` (the manual mark, cb_ read) and
 *      `taskStartForPid(pidLabel)` (the earliest task `module_start`, READ-ONLY
 *      study read). The latter is null when the study has no task module, the PID
 *      is unknown, or the participant has not reached the task yet.
 *   3. `resolveRecordingAnchorMs(manual, taskStart)` → manual (exact) when present,
 *      else auto (+correction). Null when NEITHER exists → leave the anchor unset.
 *   4. Persist `recording_started_at` (epoch-ms → ISO) to the session.
 *
 * If neither a manual mark nor a task `module_start` exists, `recording_started_at`
 * is LEFT NULL and the function returns `{anchored:false, reason}`. Idempotent:
 * re-running recomputes the same anchor and overwrites the same value (so a manual
 * mark placed after a prior auto-anchor takes over on the next run).
 */
export async function autoAnchorSession(
  sessionId: string,
): Promise<AutoAnchorResult> {
  await requireAuthUser();
  const id = (sessionId ?? '').trim();
  if (!id) return { anchored: false, reason: 'sessionId is required.' };

  const sb = await createUserServerClient();

  // 1. Resolve the session's PID (cb_ read).
  const { data: session, error: sessErr } = await sb
    .from('cb_sessions')
    .select('id, pid_label')
    .eq('id', id)
    .maybeSingle();
  if (sessErr) {
    throw new Error(`autoAnchorSession: cb_sessions select failed: ${sessErr.message}`);
  }
  if (!session) return { anchored: false, reason: `session ${id} not found.` };

  const pidLabel = (session.pid_label ?? '').trim();
  if (!pidLabel) {
    return { anchored: false, reason: 'session has no pid_label to resolve a participant.' };
  }

  // 2. The manual mark (cb_ read) and the task module_start (READ-ONLY study read).
  const [manualStartIso, taskStartIso] = await Promise.all([
    getRecordingStart(pidLabel),
    taskStartForPid(pidLabel),
  ]);

  // 3. Choose the anchor: manual (exact) over auto (+correction). Null when
  //    neither exists → leave recording_started_at unset.
  const resolved = resolveRecordingAnchorMs(manualStartIso, taskStartIso);
  if (!resolved) {
    return {
      anchored: false,
      reason: `no recording mark or task module_start for pid ${pidLabel} (anchor unset — set manually).`,
    };
  }

  // 4. Persist as ISO.
  const recordingStartedAt = new Date(resolved.recordingStartedAt).toISOString();
  const { error: updErr } = await sb
    .from('cb_sessions')
    .update({ recording_started_at: recordingStartedAt })
    .eq('id', id);
  if (updErr) {
    throw new Error(`autoAnchorSession: recording_started_at update failed: ${updErr.message}`);
  }

  return { anchored: true, recordingStartedAt, pidLabel };
}

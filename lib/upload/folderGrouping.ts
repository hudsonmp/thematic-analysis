/**
 * folderGrouping — PURE logic that resolves one PID folder's loose files into
 * its media set: { srt, videos[], audioTracks[] }.
 *
 * Context: a Zoom export PID folder may contain MULTIPLE videos (a short consent
 * recording + the long session, plus stray fragments) and — for "separate audio
 * file per participant" recordings — several per-speaker tracks under an
 * `Audio Record/` subfolder. The old `groupByPid` (in UploadSession) kept only
 * the LAST `video*.mp4` and required an SRT; both are wrong for C3:
 *   - we must keep ALL videos so a duration probe + `pickSessionVideo` can choose
 *     the session and skip the consent;
 *   - a folder with NO pre-made `_transcript.srt` must NOT be dropped — it is the
 *     trigger to GENERATE one via `/api/transcribe`.
 *
 * This module is the single source of truth for how a PID folder's files map to
 * those slots. It is I/O-free (no DOM, no fs) so the policy is unit-testable; the
 * duration probe and the actual transcribe POST stay integration-only in the UI.
 */

/** A file paired with its full relative path (`<…>/<pid>/<…>/<leaf>`). */
export type FolderFile = { file: File; relPath: string };

/** A matched media member: the file, its relpath, and the resolved leaf name. */
export type FolderMember = { file: File; relPath: string; leaf: string };

/** A PID folder's resolved media set. */
export type FolderGroup = {
  pid: string;
  /** The pre-made `<pid>_transcript.srt`, or null → must generate one. */
  srt: File | null;
  /** Every `video*.mp4` in the folder, in input order (picker chooses one). */
  videos: FolderMember[];
  /**
   * Per-speaker `audio*.m4a` tracks under `Audio Record/`, PLUS a top-level
   * `audio*.m4a` (legacy single-track layout). 2+ → speaker-labeled transcript.
   */
  audioTracks: FolderMember[];
};

/** The Zoom "separate audio file per participant" subfolder name. */
export const AUDIO_RECORD_DIR = 'Audio Record';

const SRT_RE = /_transcript\.srt$/i;
const VIDEO_RE = /^video.*\.mp4$/i;
const AUDIO_RE = /^audio.*\.m4a$/i;

/** The leaf filename from a relative path (`a/b/c.srt` → `c.srt`). */
function leafName(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] ?? relPath;
}

/**
 * Path of a file INSIDE its PID folder, i.e. the segments AFTER the first `pid`
 * segment. Returns null if the relpath does not contain `pid` as a segment.
 *
 * This is what lets `Audio Record/` tracks classify correctly: `pidOf` (segment
 * above the leaf) would mis-group `…/067/Audio Record/audioA.m4a` under a phantom
 * "Audio Record" pid. Anchoring on the pid segment instead yields the in-folder
 * path `Audio Record/audioA.m4a`, so the audio + video both resolve to pid 067.
 */
function inFolderPath(relPath: string, pid: string): string | null {
  const parts = relPath.split('/').filter(Boolean);
  const idx = parts.indexOf(pid);
  if (idx === -1 || idx === parts.length - 1) return null; // pid absent, or pid IS the leaf
  return parts.slice(idx + 1).join('/');
}

/**
 * Is this in-folder path a per-speaker track under `Audio Record/`? It must be
 * exactly one level under `Audio Record/` and match `audio*.m4a`, mirroring the
 * script's `find` scope (see transcribeRunner.classifyTrackMode).
 */
function isAudioRecordTrack(inFolder: string): boolean {
  const prefix = `${AUDIO_RECORD_DIR}/`;
  if (!inFolder.startsWith(prefix)) return false;
  const rest = inFolder.slice(prefix.length);
  if (rest.includes('/')) return false; // nested deeper → not a track
  return AUDIO_RE.test(rest);
}

/** Is this a top-level (legacy single-track) `audio*.m4a` directly in the folder? */
function isTopLevelAudio(inFolder: string): boolean {
  return !inFolder.includes('/') && AUDIO_RE.test(inFolder);
}

/**
 * Resolve every file belonging to PID folder `pid` into its media set. Files not
 * under that pid segment, or not matching the SRT/video/audio shapes, are ignored.
 * The SRT may be null (→ generate). Videos and audioTracks preserve input order.
 */
export function groupFolderFiles(pid: string, items: FolderFile[]): FolderGroup {
  const group: FolderGroup = { pid, srt: null, videos: [], audioTracks: [] };

  for (const { file, relPath } of items) {
    const rel = relPath || file.name;
    const inFolder = inFolderPath(rel, pid);
    if (inFolder === null) continue; // belongs to a different folder
    const leaf = leafName(inFolder);

    if (SRT_RE.test(leaf)) {
      // Keep the first SRT encountered (folders carry at most one).
      if (group.srt === null) group.srt = file;
    } else if (VIDEO_RE.test(leaf) && !inFolder.includes('/')) {
      // Only top-level video*.mp4 in the PID folder (not nested under subdirs).
      group.videos.push({ file, relPath: rel, leaf });
    } else if (isAudioRecordTrack(inFolder) || isTopLevelAudio(inFolder)) {
      group.audioTracks.push({ file, relPath: rel, leaf });
    }
  }

  return group;
}

/**
 * The Zoom recording-SEGMENT suffix encoded in a `video*.mp4` filename.
 *
 * Zoom writes a NEW numbered recording every time the host stops/starts. Each
 * file name carries the segment number + meeting id as a trailing digit run:
 *   `video<seg><meetingID>.mp4` — e.g. `video2639780501.mp4` → `"2639780501"`.
 * The matching per-speaker tracks share the SAME `<seg><meetingID>` tail (see
 * {@link scopeAudioTracks}), so this suffix is the join key between a chosen
 * session video and its own segment's tracks.
 *
 * Rule: take the BASENAME, strip a leading `video` prefix and a trailing
 * `.mp4` extension, then return the trailing run of digits (`\d+$`). Returns
 * null when there is no trailing digit run (e.g. a non-Zoom `video_session.mp4`).
 * Pure / I/O-free.
 */
export function sessionVideoSuffix(videoName: string): string | null {
  const leaf = leafName(videoName);
  // Strip a leading `video` prefix and a trailing `.mp4` (case-insensitive),
  // then read the trailing run of digits. We do NOT require the `video` prefix
  // or the extension — only the trailing digit run matters for the join.
  const withoutPrefix = leaf.replace(/^video/i, '');
  const withoutExt = withoutPrefix.replace(/\.mp4$/i, '');
  const m = withoutExt.match(/(\d+)$/);
  return m ? m[1] : null;
}

/**
 * Minimum length a session-video suffix must have to be a RELIABLE join key for
 * `endsWith` scoping. A real Zoom session video carries the full `<seg><meetingID>`
 * tail and meeting ids are ~9-11 digits, so the suffix is always long. A suffix
 * shorter than this (e.g. `video1.mp4` → `"1"`) is NOT a real multi-segment Zoom
 * export's join key: `endsWith("1")` would keep only tracks whose basename ends in
 * `1` and SILENTLY DROP genuine co-segment speakers (`audioBob2.m4a`). The
 * threshold (5) sits safely ABOVE a bare single/two-digit segment number and
 * BELOW a real meeting-id tail, so it cleanly separates "degenerate suffix" from
 * "real Zoom suffix". See {@link scopeAudioTracks} for the fallback behavior.
 */
export const MIN_RELIABLE_SUFFIX_LEN = 5;

/**
 * Scope per-speaker audio tracks to the chosen SESSION recording's segment.
 *
 * The bug this fixes: a participant who stopped after consent and rejoined for
 * the task has per-speaker tracks from MULTIPLE Zoom segments in one folder.
 * Sending EVERY `Audio Record/*.m4a` to `/api/transcribe` splices audio from the
 * wrong recordings (consent clip + fragments) into the transcript. A track
 * belongs to the session iff its basename (without `.m4a`) ENDS WITH the session
 * video's trailing segment suffix.
 *
 * Fallback (conservative OVER-inclusion, NEVER a silent drop): if the session
 * suffix is null (un-suffixed session video) OR too short to be a reliable join
 * key (< {@link MIN_RELIABLE_SUFFIX_LEN}), we CANNOT reliably scope — so we
 * return ALL `audioRecordTracks` rather than `endsWith`-filtering. Over-inclusion
 * is safe here because a degenerate-suffix folder is not a real multi-segment
 * Zoom export (those always carry a long `<seg><meetingID>` tail); the only cost
 * is possibly transcribing one extra short clip, whereas an `endsWith` on a bare
 * `"1"` would SILENTLY DROP a real co-segment speaker (`audioBob2.m4a`) — the
 * strictly worse failure. (When a real, long suffix yields ZERO matches, we also
 * return `[]`: every track is a genuine OTHER segment, so dropping them is
 * correct — the route then transcribes the session video's own audio.)
 *
 * The match is ANCHORED at the end of the basename, so a speaker name that
 * happens to end in another segment's digits (e.g. `…c21639780501.m4a` ends in
 * `1639780501`, NOT `2639780501`) does not cause a false match. NOTE: `endsWith`
 * on an undelimited `<seg><meetingID>` assumes single-digit segments sharing a
 * long meeting-id tail; a segment 10+ could in theory collide with a 1-prefixed
 * lower segment (e.g. seg `10…` vs seg `0…`). This is acceptable: a study session
 * has only ~2-3 stop/starts, so segment numbers never reach two digits.
 *
 * Pure / I/O-free. Preserves input order.
 */
export function scopeAudioTracks(
  sessionVideoName: string,
  audioRecordTracks: FolderMember[],
): FolderMember[] {
  const suffix = sessionVideoSuffix(sessionVideoName);
  // Degenerate suffix (null or too short) → cannot reliably scope → over-include
  // ALL tracks rather than risk silently dropping a real co-segment speaker.
  if (suffix === null || suffix.length < MIN_RELIABLE_SUFFIX_LEN) {
    return audioRecordTracks;
  }
  const scoped = audioRecordTracks.filter((t) => {
    const base = leafName(t.relPath || t.leaf || t.file.name).replace(/\.m4a$/i, '');
    return base.endsWith(suffix);
  });
  return scoped;
}

/**
 * Pick the ONE per-speaker track to store as the session's playback `audio_path`.
 *
 * The schema holds a single `audio_path`, and that stored clip must belong to the
 * SAME Zoom segment as the transcript. Prefer the first SCOPED (session-segment)
 * track; fall back to the first UNSCOPED track only when scoping produced nothing
 * (e.g. a legacy single top-level `audio*.m4a`, or a degenerate-suffix folder).
 * Without this, a multi-segment folder whose FIRST unscoped track is a consent
 * (segment-1) clip would store consent audio against a segment-2 transcript.
 *
 * Pure / I/O-free.
 */
export function pickPlaybackAudio(
  scopedTracks: FolderMember[],
  allTracks: FolderMember[],
): File | null {
  return scopedTracks[0]?.file ?? allTracks[0]?.file ?? null;
}

/**
 * The distinct PID folders present in a pool, ordered numerically-then-lexically.
 * A PID is the FIRST path segment that is followed by at least one more segment
 * (i.e. `<…>/<pid>/<…>`). We anchor on the LAST two segments' parent so a single
 * dropped folder (`067/…`) and a rooted tree (`Zoom/067/…`) both yield `067`.
 *
 * Implementation: reuse the same "segment above the leaf" rule the original
 * upload UI used to enumerate PIDs, then de-dupe. (Audio tracks nested under
 * `Audio Record/` would yield a phantom pid here, so we EXCLUDE any segment named
 * `Audio Record` from being treated as a PID.)
 */
export function pidsInPool(items: FolderFile[]): string[] {
  const seen = new Set<string>();
  for (const { file, relPath } of items) {
    const rel = relPath || file.name;
    const parts = rel.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const candidate = parts[parts.length - 2];
    if (candidate === AUDIO_RECORD_DIR) {
      // The leaf is an Audio Record track; the real pid is one level higher.
      if (parts.length >= 3) seen.add(parts[parts.length - 3]);
      continue;
    }
    seen.add(candidate);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

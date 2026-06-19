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

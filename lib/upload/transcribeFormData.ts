/**
 * transcribeFormData — PURE description of the multipart body POSTed to
 * `/api/transcribe`, matching the C2 route contract exactly.
 *
 * The route (app/api/transcribe/route.ts) reads:
 *   - field `session` → the chosen SESSION video File (written to the temp
 *     folder root);
 *   - EVERY other File field → written at the relative path equal to its field
 *     NAME. To make the script's per-speaker detection fire, each track must be
 *     sent under `Audio Record/<leaf>` so it lands in the `Audio Record/`
 *     subfolder the script's `find` scopes to.
 *
 * This module returns a plain `{ field, file }[]` (no DOM `FormData`) so the
 * contract is unit-testable in Node; the UI converts it to a real `FormData`.
 */

import type { FolderFile } from './folderGrouping';
export type { FolderFile } from './folderGrouping';

/** Reserved multipart field carrying the chosen session video (matches route). */
export const SESSION_FIELD = 'session';

/** The Zoom per-participant audio subfolder (matches route + runner). */
export const AUDIO_RECORD_DIR = 'Audio Record';

/** One multipart entry: a field name and the File it carries. */
export type TranscribeEntry = { field: string; file: File };

/** The leaf filename from a relative path (`a/b/c.m4a` → `c.m4a`). */
function leafName(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] ?? relPath;
}

/**
 * Build the multipart entries for a transcribe POST:
 *   - the session video under field `session`;
 *   - each per-speaker track under field `Audio Record/<leaf>` (its in-folder
 *     relative path), so the route reconstructs the Zoom layout and the script
 *     emits a speaker-labeled SRT when ≥2 tracks are present.
 *
 * Pure: produces a describable list; the caller appends them to a real FormData.
 */
export function buildTranscribeEntries(
  sessionVideo: File,
  audioTracks: FolderFile[],
): TranscribeEntry[] {
  const entries: TranscribeEntry[] = [{ field: SESSION_FIELD, file: sessionVideo }];
  for (const track of audioTracks) {
    const leaf = leafName(track.relPath || track.file.name);
    entries.push({ field: `${AUDIO_RECORD_DIR}/${leaf}`, file: track.file });
  }
  return entries;
}

/** Convert the pure entries into a real browser `FormData` for the fetch POST. */
export function toFormData(entries: TranscribeEntry[]): FormData {
  const fd = new FormData();
  for (const { field, file } of entries) fd.append(field, file, file.name);
  return fd;
}

// ---------------------------------------------------------------------------
// Recording anchor — Task 4 of the live co-observation feature.
//
// The recording (Zoom) is on a RELATIVE clock (t=0 = record start); every other
// stream (participant `study_events`, analyst observations) is on the ABSOLUTE
// UTC clock. Capturing the single anchor `recording_started_at` (in absolute
// time) is the entire synchronization problem — alignment is then a subtraction:
// `video_offset = event.created_at − recording_started_at`.
//
// The recording is started MANUALLY when the subject reaches the `task` module,
// so there is a small, human reaction-time gap between the task `module_start`
// event and the moment the recording actually begins. `ANCHOR_CORRECTION_MS`
// absorbs that gap: we anchor at `task module_start + ANCHOR_CORRECTION_MS` so a
// live flag (or auto-derived episode mark) lands ON the moment in the eventual
// recording rather than ~2 s early, without the researcher scrubbing to correct.
//
// This module is a PURE, side-effect-free helper (no I/O, no DB, no `server-only`
// bound) so it is unit-testable and usable on either the server (the anchor write
// in app/actions/sessions.ts) or the client. The single named constant keeps the
// correction tunable in one place.
// ---------------------------------------------------------------------------

/**
 * The recording-anchor correction, in milliseconds.
 *
 * Added to the task `module_start` time to absorb the record-start reaction gap
 * (the recording begins a beat AFTER the participant enters the task module).
 * One named, tunable constant — change it here and every anchor recomputes.
 */
export const ANCHOR_CORRECTION_MS = 2000;

/**
 * Compute the recording anchor (epoch milliseconds) from the task `module_start`
 * timestamp: `taskModuleStart + ANCHOR_CORRECTION_MS`.
 *
 * `taskModuleStartIso` is the `study_events.created_at` of the participant's task
 * `module_start` (an ISO-8601 / Postgres timestamptz string). Returns the
 * absolute anchor in epoch-ms, which the caller persists to
 * `cb_sessions.recording_started_at`.
 *
 * Throws on an unparseable timestamp rather than silently producing `NaN` — a bad
 * anchor would misplace every downstream marker, so it must fail loud at the
 * boundary where the value enters the system.
 */
export function computeAnchorMs(taskModuleStartIso: string): number {
  const baseMs = Date.parse(taskModuleStartIso);
  if (Number.isNaN(baseMs)) {
    throw new Error(
      `computeAnchorMs: unparseable task module_start timestamp: ${JSON.stringify(
        taskModuleStartIso,
      )}`,
    );
  }
  return baseMs + ANCHOR_CORRECTION_MS;
}

/** The resolved recording anchor and HOW it was sourced. `source:'manual'` is the
 *  researcher's exact "Start recording" click (cb_recording_marks); `source:'auto'`
 *  is the derived `task module_start + ANCHOR_CORRECTION_MS` fallback. `recordingStartedAt`
 *  is the absolute anchor in epoch-ms. `null` when neither source is available. */
export type ResolvedAnchor =
  | { source: 'manual'; recordingStartedAt: number }
  | { source: 'auto'; recordingStartedAt: number }
  | null;

/**
 * Choose the recording anchor, MANUAL over AUTO.
 *
 * The manual mark (`cb_recording_marks.started_at`, the instant the researcher hit
 * record) is the SOURCE OF TRUTH when present: it is used EXACTLY — NO
 * `ANCHOR_CORRECTION_MS` — because the click already captures the real record
 * start, so there is no reaction gap to absorb. When there is no manual mark we
 * fall back to the AUTO derivation: `task module_start + ANCHOR_CORRECTION_MS`
 * (the +2 s reaction correction). When neither exists, the anchor is unresolved
 * (`null`) and the caller leaves `recording_started_at` unset.
 *
 * Pure: both inputs are ISO strings (or null); an unparseable manual mark is
 * ignored (falls through to auto) rather than throwing, since a malformed mark
 * must not block the auto fallback. The auto path still delegates to
 * `computeAnchorMs`, which throws on an unparseable task-start (a bad task-start
 * is a hard error — there is no further fallback).
 */
export function resolveRecordingAnchorMs(
  manualStartIso: string | null,
  taskModuleStartIso: string | null,
): ResolvedAnchor {
  if (manualStartIso) {
    const manualMs = Date.parse(manualStartIso);
    // Exact: the manual click already is the record start (no +correction).
    if (!Number.isNaN(manualMs)) {
      return { source: 'manual', recordingStartedAt: manualMs };
    }
    // A malformed manual mark must not block the auto fallback — fall through.
  }
  if (taskModuleStartIso) {
    return { source: 'auto', recordingStartedAt: computeAnchorMs(taskModuleStartIso) };
  }
  return null;
}

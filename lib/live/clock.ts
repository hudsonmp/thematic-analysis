// ---------------------------------------------------------------------------
// Live clock formatting — pure helpers for the Live Follow surface.
//
// These back the in-the-moment task clock and the observation timestamps. They
// are PURE (no I/O, no DB, no `server-only` bound) so they unit-test cleanly and
// run on either the server or the client. `LiveFollow.tsx` imports them.
//
// The clock previews where a live flag lands in the eventual recording
// (`elapsed = endpoint − taskStart`). While the participant is working the
// endpoint is `Date.now()` (ticking); once they reach the finished screen
// (`study_complete`) the endpoint becomes the fixed `taskEndedAt`, so the
// elapsed FREEZES at `study_complete − taskStart`.
// ---------------------------------------------------------------------------

/**
 * Format `endpoint − taskStart` as `mm:ss` (minutes uncapped). Null when there
 * is no task-start anchor (clock not running).
 *
 * The endpoint is `taskEndedAt` when the participant has finished (the elapsed
 * freezes at `study_complete − taskStart`), else `Date.now()` (live ticking). A
 * negative span (clock skew, or an end before start) clamps to 0.
 */
export function formatElapsed(
  taskStartedAt: string | null,
  taskEndedAt: string | null,
): string | null {
  if (!taskStartedAt) return null;
  const startMs = Date.parse(taskStartedAt);
  if (Number.isNaN(startMs)) return null;

  let endMs = Date.now();
  if (taskEndedAt) {
    const parsed = Date.parse(taskEndedAt);
    if (!Number.isNaN(parsed)) endMs = parsed;
  }
  return mmss(Math.max(0, endMs - startMs));
}

/**
 * An observation's clock-relative time: `created_at − taskStart` as `mm:ss`
 * when the anchor exists, else the wall-clock time of day (no anchor yet).
 */
export function observationTime(createdAt: string, taskStartedAt: string | null): string {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return '—';
  if (taskStartedAt) {
    const startMs = Date.parse(taskStartedAt);
    if (!Number.isNaN(startMs)) return mmss(Math.max(0, createdMs - startMs));
  }
  // No anchor: show the wall time so the row is still locatable.
  return new Date(createdMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Format an ISO timestamp as a `YYYY-MM-DD` session date (UTC). Null/empty/
 * unparseable input yields null so the caller can omit the date. UTC is chosen
 * for stability: the session date should not drift across the viewer's timezone.
 */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Milliseconds → `mm:ss` (minutes uncapped past 60). */
export function mmss(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

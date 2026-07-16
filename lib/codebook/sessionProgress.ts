/**
 * sessionProgress — PURE logic for a session's coding progress.
 *
 * Two axes, deliberately separate:
 *   PER-CODER status — where THIS coder is on THIS session. Lives on
 *     cb_session_coding_status, RLS-scoped to coder_id = auth.uid(), so one coder's
 *     progress never reads or writes another's. Absent row = not_started.
 *   SESSION status — reconciliation. A single session-level flag
 *     (cb_sessions.reconciliation_at) that OVERRIDES every coder's per-coder status in
 *     the display: once a session is in reconciliation, everyone sees "Reconciliation."
 *     It does nothing functional yet (decision: reconciliation is a coordination marker
 *     for now), which is why it is a pure display override and not a gate.
 *
 * The override direction matters: reconciliation is a property of the SESSION (the team
 * has moved past independent coding), so it must win over any individual's stale
 * per-coder state. A coder still showing "individual coding" after the team declared
 * reconciliation would misreport where the work actually is.
 */

/** The three per-coder states. `not_started` is represented by the ABSENCE of a row. */
export type CoderStatus = 'not_started' | 'in_progress' | 'individual_coding';

/** What a row is shown as — the per-coder states plus the session-level override. */
export type DisplayStatus = CoderStatus | 'reconciliation';

export const CODER_STATUSES: CoderStatus[] = [
  'not_started',
  'in_progress',
  'individual_coding',
];

const LABELS: Record<DisplayStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  individual_coding: 'Individual Coding',
  reconciliation: 'Reconciliation',
};

export function statusLabel(s: DisplayStatus): string {
  return LABELS[s];
}

/**
 * The status to SHOW for a session, given this coder's own status and whether the
 * session is in reconciliation. Reconciliation overrides; otherwise it is the coder's
 * own state.
 */
export function displayStatus(
  coderStatus: CoderStatus,
  reconciliationAt: string | null,
): DisplayStatus {
  return reconciliationAt != null ? 'reconciliation' : coderStatus;
}

/**
 * Map a stored `cb_session_coding_status` row (or its absence) to a CoderStatus.
 * A missing/unknown status string degrades to `individual_coding` only when a row
 * EXISTS (a row means the coder engaged); no row at all is `not_started`.
 */
export function coderStatusFromRow(row: { status: string } | null | undefined): CoderStatus {
  if (!row) return 'not_started';
  return row.status === 'in_progress' ? 'in_progress' : 'individual_coding';
}

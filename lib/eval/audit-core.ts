// Pure core of the safety-L5 runtime study audit (no next/headers, no client)
// so it unit-tests under vitest — same split as study-guard-core.ts /
// study-guard.ts. `takeStudyFingerprint` / `withStudyAudit` (audit.ts) compose
// this diff with live head-counts around every eval write action.

/** Study-table row counts keyed by table name, taken at one instant. A count of
 *  -1 means "count FAILED" (query error or null count) — see audit.ts for why a
 *  failed count is recorded as a sentinel rather than dropped: a missing key
 *  would read as "table vanished", and a fabricated 0 would read as "table
 *  emptied"; -1 is honest about knowing nothing while still never comparing
 *  equal to any real count. */
export type StudyFingerprint = Record<string, number>;

/**
 * Diff two fingerprints into human-readable drift lines; `[]` means clean.
 *
 * One line per drifted table, in three shapes:
 *  - count changed:            "study_snapshots: 172 -> 173"
 *  - in before, not in after:  "users: present before, missing after"
 *  - in after, not in before:  "evalx: absent before, present after"
 *
 * The membership cases exist for defense in depth, not because they are
 * expected: both fingerprints come from the same closed STUDY_TABLES loop, so
 * a key mismatch means the audit itself is broken (or someone diffed
 * fingerprints from different code versions) — which is exactly when staying
 * silent would be worst.
 *
 * Output is sorted by table name (plain code-unit sort — deterministic across
 * environments, unlike locale-aware collation) so the audit-failure message,
 * which gets logged and asserted on, never depends on object insertion order.
 */
export function diffFingerprints(
  before: StudyFingerprint,
  after: StudyFingerprint,
): string[] {
  const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const lines: string[] = [];
  for (const table of tables) {
    const inBefore = table in before;
    const inAfter = table in after;
    if (inBefore && !inAfter) {
      lines.push(`${table}: present before, missing after`);
    } else if (!inBefore && inAfter) {
      lines.push(`${table}: absent before, present after`);
    } else if (before[table] !== after[table]) {
      lines.push(`${table}: ${before[table]} -> ${after[table]}`);
    }
  }
  return lines;
}

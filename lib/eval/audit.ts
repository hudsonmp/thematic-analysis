import 'server-only';
import { STUDY_TABLES } from '@/lib/supabase/study-guard-core';
import { studyFrom } from '@/lib/supabase/study-guard';
import { diffFingerprints, type StudyFingerprint } from '@/lib/eval/audit-core';

/**
 * Head-count every study table into a fingerprint. This is safety L5's runtime
 * belt: cheap (10 HEAD requests, no rows transferred) and taken through
 * `studyFrom`, so the fingerprint itself cannot write.
 *
 * A failed count (query `.error` or a null `count`) is recorded as -1, NOT
 * skipped and NOT defaulted to 0: a failed count must not mask drift as a
 * match. -1 never equals a real count, so "couldn't count before" vs "real
 * count after" (or vice versa) always surfaces as drift. The residual: if the
 * SAME table fails on BOTH sides, -1 == -1 compares clean and drift on that
 * table would go unseen for that one window — accepted, because the
 * alternative (throwing on any transient count failure) would fail every
 * audited action during a network blip and train callers to bypass the belt.
 */
export async function takeStudyFingerprint(): Promise<StudyFingerprint> {
  // All 10 counts in parallel: keeps the snapshot window narrow, so the
  // fingerprint approximates one instant rather than a 10-request smear.
  const entries = await Promise.all(
    STUDY_TABLES.map(async (table) => {
      const { count, error } = await (
        await studyFrom(table)
      ).select('*', { count: 'exact', head: true });
      return [table, error !== null || count === null ? -1 : count] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Wrap an eval WRITE action in a pre/post study-table fingerprint. Every eval
 * action that writes anything goes through this — it is the last, runtime
 * layer (L5) over the structural ones (SELECT-only RLS on the researcher JWT,
 * studyFrom's write-verb proxy, evalFrom's closed allowlist).
 *
 * Honest coverage statement: head-count fingerprints detect INSERT/DELETE
 * drift only. UPDATE drift (same row count, changed content) is invisible to
 * this belt and is covered by the structural layers above, not here.
 *
 * On drift the audit THROWS — loud, never swallowed, never warn-only: a study
 * row count that moved across an eval write means IRB data was touched, and
 * no eval result is worth returning past that.
 *
 * If `fn` itself throws, we STILL take the post-fingerprint before deciding
 * what to rethrow: a failed action that half-wrote study data is the WORST
 * case, and surfacing only the action's own error would bury the drift. So —
 * drift + action error → one combined audit failure carrying both; no drift →
 * the original error propagates untouched.
 */
export async function withStudyAudit<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const before = await takeStudyFingerprint();
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // Guard the post-fingerprint itself (review NIT): if IT throws (exotic —
    // query errors become -1, but an abort/env failure can still escape), the
    // action's ORIGINAL error must not be masked by the audit's own failure.
    let after: StudyFingerprint | null = null;
    try {
      after = await takeStudyFingerprint();
    } catch (auditErr) {
      console.error(
        `[audit] post-fingerprint failed after "${label}" (original action error rethrown):`,
        auditErr,
      );
      throw err;
    }
    const lines = diffFingerprints(before, after);
    if (lines.length > 0) {
      throw new Error(
        `STUDY-DATA AUDIT FAILURE after "${label}": ${lines.join('; ')}` +
          `; underlying action error: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    throw err;
  }
  const after = await takeStudyFingerprint();
  const lines = diffFingerprints(before, after);
  if (lines.length > 0) {
    throw new Error(
      `STUDY-DATA AUDIT FAILURE after "${label}": ${lines.join('; ')}`,
    );
  }
  return result;
}

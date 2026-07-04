// Pure core of the EVAL-table guard (no next/headers, no client) so it unit-tests
// under vitest. Mirrors study-guard-core.ts's allowlist half: eval_* tables are
// the eval harness's OWN storage (safety spec L5) — writable, unlike study
// tables — so there is NO selectOnly proxy here. The guard exists so a typo'd
// table name can never reach cb_/study_ data through this path, and so CI can
// quarantine raw clients to the three guard modules. `evalFrom` (eval-guard.ts)
// composes this core with the user client.

/** Every eval-harness table this app may READ AND WRITE. Closed allowlist —
 *  adding a table is a deliberate, reviewed act. (cb_* tables go through cbFrom;
 *  study tables are read-only via studyFrom.) */
export const EVAL_TABLES = [
  'eval_annotations',
  'eval_artifacts',
  'eval_few_shot_sets',
  'eval_prompt_variants',
  'eval_runs',
  'eval_verdicts',
] as const;

export type EvalTable = (typeof EVAL_TABLES)[number];

/** Throws unless `table` is on the closed eval-table allowlist. Runtime twin of
 *  the compile-time `EvalTable` bound (mirrors assertStudyTable's role for
 *  studyFrom). */
export function assertEvalTable(table: string): void {
  if (!(EVAL_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `evalFrom: "${table}" is not an eval table (closed allowlist; cb_ writes go through cbFrom, study reads through studyFrom).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers for the annotate → fold-into-variant surface (Task B3-4 / B3-4b).
//
// B3-4b closes the loop the original B3-4 could not: `saveAnnotation` now
// RETURNS the new row id and a `listUnfoldedAnnotations()` read action exists,
// so the fold panel drives off a CHECKBOX list of real, still-unfolded DB rows
// instead of a paste field. That killed the old paste-normalizer
// (`parseAnnotationIds`) — the client no longer parses researcher-typed ids.
//
// The one piece of contestable logic that survives is the mapping from the
// checkbox selection to the fold's id list. `foldAnnotationsIntoVariant`
// refuses a PARTIAL fold — it throws when the resolved-count (rows still in the
// DB) differs from the requested `new Set(ids).size`. Because the checkbox list
// is a snapshot (fetched on mount, refreshed after each save/fold), a checked
// id can go stale between refreshes. `selectableCheckedIds` intersects the
// checked set with the CURRENTLY-available ids so the fold request only ever
// carries ids the action can still resolve — a stale check can never spuriously
// trip the partial-fold refusal.
//
// The panel ALSO tracks the notes saved THIS session (an advisory recall list),
// labelled by their (run · verdict) context via `contextLabel`.
// ---------------------------------------------------------------------------

/** One note captured this session, with the verdict/run context it was saved
 *  under. Carried through AnnotateContext as a lightweight signal that a save
 *  happened (drives the unfolded-list refresh) and as a human-readable recall
 *  aid. PID: pid only — never first_name/email (spec L5). */
export type PendingAnnotation = {
  note: string;
  runId?: string;
  verdictId?: string;
  /** pid ONLY — never first_name/email (spec L5). */
  pid?: string;
  phaseOrdinal?: number;
  scenarioIdx?: number | null;
  /** Local monotonic key for React lists (not a DB id). */
  localKey: string;
};

/**
 * The exact id list to hand `foldAnnotationsIntoVariant`, given the researcher's
 * checkbox selection and the ids currently available in the unfolded list.
 *
 * Returns the AVAILABLE ids (in their list order) that are checked — an
 * intersection. This pins the request to the action's `new Set(...)` count:
 * only ids the action can still resolve are sent, so a stale check (its row
 * folded by a prior fold) is silently dropped rather than tripping the
 * partial-fold refusal. Available ids are unique DB ids, so the result is
 * duplicate-free by construction.
 */
export function selectableCheckedIds(checked: Set<string>, available: string[]): string[] {
  return available.filter((id) => checked.has(id));
}

/** A still-unfolded annotation as the fold panel consumes it (camelCase). The
 *  source of truth for the shape; `app/actions/eval.ts` re-exports it. The
 *  (pid · phaseOrdinal · scenarioIdx) coordinates bind a note to a per-cell
 *  review position; they are null for legacy/unscoped annotations. pid is the
 *  study's de-identified id ONLY — never first_name/email (spec L5). */
export type AnnotationRow = {
  id: string;
  note: string;
  runId: string | null;
  verdictId: string | null;
  pid: string | null;
  phaseOrdinal: number | null;
  scenarioIdx: number | null;
  createdAt: string;
};

/** The raw eval_annotations row shape the DB returns (snake_case). */
export type DbAnnotationRow = {
  id: string;
  note: string;
  run_id: string | null;
  verdict_id: string | null;
  pid: string | null;
  phase_ordinal: number | null;
  scenario_idx: number | null;
  created_at: string;
};

/** snake_case DB row → camelCase AnnotationRow. Extracted as a PURE function so
 *  the field mapping is unit-pinned: a transposition (e.g. run_id → verdictId,
 *  or phase_ordinal → scenarioIdx — both numbers) type-checks, so only a test
 *  catches it, not tsc. */
export function mapAnnotationRow(row: DbAnnotationRow): AnnotationRow {
  return {
    id: row.id,
    note: row.note,
    runId: row.run_id,
    verdictId: row.verdict_id,
    pid: row.pid,
    phaseOrdinal: row.phase_ordinal,
    scenarioIdx: row.scenario_idx,
    createdAt: row.created_at,
  };
}

/** The camelCase input a caller hands `saveAnnotation` (note already validated
 *  by the action; coordinates optional). */
export type AnnotationInsertInput = {
  note: string;
  runId?: string;
  verdictId?: string;
  pid?: string;
  phaseOrdinal?: number;
  scenarioIdx?: number;
};

/** camelCase input → the snake_case eval_annotations INSERT row (absent →
 *  null). Extracted + unit-pinned for the SAME reason as mapAnnotationRow, and
 *  the write path is the more dangerous one: a phaseOrdinal↔scenarioIdx swap
 *  here (both numbers, tsc-invisible) files every per-cell note under the wrong
 *  scenario permanently, with nothing in the UI to reveal it. */
export function annotationInsertRow(input: AnnotationInsertInput): {
  note: string;
  run_id: string | null;
  verdict_id: string | null;
  pid: string | null;
  phase_ordinal: number | null;
  scenario_idx: number | null;
} {
  return {
    note: input.note,
    run_id: input.runId ?? null,
    verdict_id: input.verdictId ?? null,
    pid: input.pid ?? null,
    phase_ordinal: input.phaseOrdinal ?? null,
    scenario_idx: input.scenarioIdx ?? null,
  };
}

/** A short, human-readable context label for a pending annotation — the
 *  (pid · phase · scenario) coordinates when known, else the run/verdict id, so
 *  the recall list reads meaningfully. pid only (never name/email). */
export function contextLabel(a: PendingAnnotation): string {
  const parts: string[] = [];
  if (a.pid) parts.push(a.pid);
  if (a.phaseOrdinal !== undefined) parts.push(`phase ${a.phaseOrdinal}`);
  if (a.scenarioIdx !== undefined && a.scenarioIdx !== null) parts.push(`sc ${a.scenarioIdx}`);
  if (parts.length > 0) return parts.join(' · ');
  if (a.verdictId) return `verdict ${a.verdictId}`;
  if (a.runId) return `run ${a.runId}`;
  return 'unscoped';
}

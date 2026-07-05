// ---------------------------------------------------------------------------
// Pure helpers for the annotate → fold-into-variant surface (Task B3-4).
//
// WHY A PURE MODULE HERE: the committed eval actions (app/actions/eval.ts) shape
// this task in a way the plan under-specified. `saveAnnotation` returns `void`
// (no `.select()`), and there is NO annotation READ action — and B3 may add no
// new server action / DB access. So a session never learns the DB id of a note
// it just saved. `foldAnnotationsIntoVariant(annotationIds, ...)`, however,
// requires REAL DB ids, and it FAILS LOUD if the resolved-count ≠ the requested
// set size (it de-dupes with `new Set(annotationIds).size` and refuses a partial
// fold). Therefore the only honest, no-new-action wiring is: the researcher
// supplies the ids to fold, and the client must normalize them EXACTLY the way
// the action counts them — dedupe preserving order, drop blanks — or the count
// check will misfire. That normalization is the contestable logic the plan says
// to extract + unit-test rather than bury in JSX; it pins the client's set to
// the action's `new Set(...)` semantics so a stray comma or duplicate paste can
// never trip the partial-fold refusal spuriously.
//
// The panel ALSO tracks the notes saved THIS session (an advisory recall list —
// text only, since no id comes back) so the researcher can see what they
// annotated and label each by its (run · verdict) context.
// ---------------------------------------------------------------------------

/** One note captured this session, with the verdict/run context it was saved
 *  under. No `id` — the committed `saveAnnotation` returns void, so the client
 *  cannot know the DB id; this is a RECALL aid, not the fold input. PII: pid
 *  only (carried for the human-readable context label). */
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
 * Normalize a researcher-pasted id blob into the exact set the fold action
 * counts. Splits on commas and any whitespace (so newline- or space- or
 * comma-separated all work), trims, drops empties, and DE-DUPES while
 * PRESERVING first-seen order. Mirrors the action's `new Set(annotationIds)` —
 * a duplicate or trailing separator can never spuriously trip its partial-fold
 * refusal.
 */
export function parseAnnotationIds(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of (raw ?? '').split(/[\s,]+/)) {
    const id = tok.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
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

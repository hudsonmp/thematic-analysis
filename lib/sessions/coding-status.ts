// Pure merge of a coder's "done" set onto the session index rows.
//
// The per-coder session-coding-status feature is read in two SELECTs in
// `listSessionsCloud` (the sessions themselves, then the SIGNED-IN coder's
// cb_session_coding_status rows). This module holds the PURE join between the two
// so the merge is unit-testable without a database: given the un-flagged rows and
// the set of session ids the coder has marked done, stamp each row's `done`.
//
// Kept tiny and side-effect-free on purpose; the Supabase reads (and the
// per-coder `coder_id = auth.uid()` filter that scopes the done-set) live in the
// server action.

/** A session index row before its per-coder `done` flag is merged in: the
 *  `SessionListRow` shape minus `done`. */
export type SessionRowWithoutDone = {
  id: string;
  pidLabel: string;
  collection: string;
  durationMs: number | null;
  trackMode: string;
};

/** A session index row with the coder's `done` flag merged in. */
export type SessionRowWithDone = SessionRowWithoutDone & { done: boolean };

/**
 * Stamp each row's `done` from `doneIds` — the set of session ids the signed-in
 * coder has marked done. A row whose `id` is in the set is done; every other row
 * is not. Pure: returns a new array, mutates neither input. The empty-set case
 * (the coder has marked nothing) flags every row `done: false`.
 */
export function mergeDoneSet(
  rows: readonly SessionRowWithoutDone[],
  doneIds: ReadonlySet<string>,
): SessionRowWithDone[] {
  return rows.map((r) => ({ ...r, done: doneIds.has(r.id) }));
}

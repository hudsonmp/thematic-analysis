import { compositionKey, type ActionCodingView, type CompositionAnswer, type QuestionLite } from './schema';

/**
 * projection — how a stored action-layer coding becomes the thing the player
 * renders. Pure, so the snapshot-vs-live question is decided in ONE tested
 * place instead of inline in a `'use server'` module.
 *
 * A coding is a COMPLETED CODING ACT: what this coder attached to this span at
 * the moment they attached it. The reusable action it points at is a shortcut
 * for entering that judgement, not a live definition of it. So the snapshot
 * columns are the truth and the vocabulary is never read through — otherwise
 * any editor calling updateAction (service-role, RLS-bypassing) silently
 * rewrites what every coder's existing codings say, with no audit trail.
 *
 * Pinning alone would trade a loud problem for a quiet one: the catalog would
 * say one thing and the codings another with no signal. So we also report
 * `drifted` — the action still exists but no longer matches what was coded —
 * and leave it to the UI to surface. Drift is a reconciliation prompt, never
 * an automatic rewrite.
 */

/** One cb_action_codings row, camel-cased. The composition columns are the
 *  SNAPSHOT taken when the coder attached it. */
export type CodingSnapshotRow = {
  id: string;
  actionId: string | null;
  actionName: string | null;
  moveIds: string[];
  objectIds: string[];
  objectRoles: Record<string, string>;
  answers: CompositionAnswer[];
};

/** A reusable action as it exists in the vocabulary RIGHT NOW. */
export type ActionLite = {
  id: string;
  name: string;
  moveIds: string[];
  objectIds: string[];
  objectRoles: Record<string, string>;
  answers: CompositionAnswer[];
};

export function codingDetail(
  row: CodingSnapshotRow,
  actions: ActionLite[],
  questions: QuestionLite[],
): { detail: ActionCodingView; drifted: boolean } {
  const detail: ActionCodingView = {
    id: row.id,
    actionId: row.actionId,
    actionName: row.actionName,
    moveIds: row.moveIds,
    objectIds: row.objectIds,
    answers: row.answers,
    objectRoles: row.objectRoles,
  };

  // An ad hoc coding points at nothing, and an action deleted out from under a
  // coding leaves nothing to compare against — neither can drift.
  const live = row.actionId ? actions.find((a) => a.id === row.actionId) ?? null : null;
  if (!live) return { detail, drifted: false };

  const drifted =
    live.name !== row.actionName ||
    compositionKey(live, questions) !== compositionKey(row, questions);

  return { detail, drifted };
}

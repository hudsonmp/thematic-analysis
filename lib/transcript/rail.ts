// Pure layout math for the review-mode comment RAIL (the marginalia beside the
// transcript). No DOM, no React — just "which annotation's notes hang in which
// turn's gutter, and which ones are visible at all". Kept here so it is
// unit-testable and the component only does rendering.
//
// A margin entry is shown ONLY for an annotation with ≥1 note: marginalia ARE the
// notes, so an annotation with nothing to say renders nothing. A bare quote's
// yellow span in the text is its presence (clicking it opens the thread), and a
// bare code anchor renders as a gutter brace — neither earns a persistent margin
// entry. The transient composer (a fresh, uncommitted selection) is laid out
// separately by the caller.

/** The minimal annotation shape the rail reads. `MyAnnotationView` is assignable. */
export type RailAnnotation = {
  id: string;
  /** The START segment id — the card anchors to this segment's turn. */
  segmentId: string;
};

/** An annotation eligible for a persistent rail card, with its anchor turn. */
export type RailCard = {
  annId: string;
  /** The turn whose gutter hosts the card (index into the turns array). */
  turnIdx: number;
};

/**
 * Decide whether an annotation earns a PERSISTENT margin entry: it has at least
 * one note. `commentedAnnIds` is the set the player already derives (annotations
 * with ≥1 comment, reconciled against the loaded threads), so this stays the
 * single source of truth for "has notes". Quotes are NOT special-cased: a bare
 * quote's yellow span is its presence, and an empty margin entry beside it would
 * be chrome saying nothing.
 */
export function annotationHasRailCard(
  ann: RailAnnotation,
  commentedAnnIds: Set<string>,
): boolean {
  return commentedAnnIds.has(ann.id);
}

/**
 * Group every rail-eligible annotation into the turn whose gutter hosts its
 * margin entry.
 *
 * For each annotation we resolve its START segment id → seg index (`segIndexById`)
 * → turn index (`turnIndexBySegIdx`). An annotation whose start segment isn't in
 * the active version (e.g. a stale id after a version switch) is dropped — its
 * highlight already degrades gracefully and a card with no on-screen anchor would
 * be orphaned. Cards within a turn keep the input order of `annotations` (which
 * the player sorts by playback time), so a turn's stacked cards read top-to-bottom
 * in time order.
 *
 * Returns a Map keyed by turn index; a turn with no cards has no entry.
 */
export function cardsByTurn(
  annotations: RailAnnotation[],
  commentedAnnIds: Set<string>,
  segIndexById: Map<string, number>,
  turnIndexBySegIdx: Map<number, number>,
): Map<number, RailCard[]> {
  const out = new Map<number, RailCard[]>();
  for (const ann of annotations) {
    if (!annotationHasRailCard(ann, commentedAnnIds)) continue;
    const segIdx = segIndexById.get(ann.segmentId);
    if (segIdx === undefined) continue;
    const turnIdx = turnIndexBySegIdx.get(segIdx);
    if (turnIdx === undefined) continue;
    const list = out.get(turnIdx) ?? [];
    list.push({ annId: ann.id, turnIdx });
    out.set(turnIdx, list);
  }
  return out;
}

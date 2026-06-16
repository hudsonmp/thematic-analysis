// Pure layout math for the review-mode comment RAIL (the Google-Docs-style margin
// of cards beside the transcript). No DOM, no React — just "which annotation's
// card hangs in which turn's gutter, and which ones are visible at all". Kept here
// so it is unit-testable and the component only does rendering.
//
// A card is shown for an annotation that carries SIGNAL on the rail: it has ≥1
// comment, OR it is an important quote (`kind === 'quote'`). A bare code anchor
// with no comments does NOT get a persistent card (it is still visible as an
// emerald span in the transcript and opens a card on click). The transient
// composer (a fresh, uncommitted selection) is laid out separately by the caller.

/** The minimal annotation shape the rail reads. `MyAnnotationView` is assignable. */
export type RailAnnotation = {
  id: string;
  /** The START segment id — the card anchors to this segment's turn. */
  segmentId: string;
  kind: string;
};

/** An annotation eligible for a persistent rail card, with its anchor turn. */
export type RailCard = {
  annId: string;
  /** The turn whose gutter hosts the card (index into the turns array). */
  turnIdx: number;
};

/**
 * Decide whether an annotation earns a PERSISTENT card on the rail: it has at
 * least one comment, OR it is an important quote. `commentedAnnIds` is the set the
 * player already derives (annotations with ≥1 comment, reconciled against the
 * loaded threads), so this stays the single source of truth for "has comments".
 */
export function annotationHasRailCard(
  ann: RailAnnotation,
  commentedAnnIds: Set<string>,
): boolean {
  return ann.kind === 'quote' || commentedAnnIds.has(ann.id);
}

/**
 * Group every rail-eligible annotation into the turn whose gutter hosts its card.
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

/**
 * gutter — PURE layout policy for the code-annotation gutter beside the transcript.
 *
 * Code annotations do NOT render as inline highlights (highlights mean comments/flags
 * — a different speech act: "I have something to say about this text" vs "this text IS
 * an instance of code X"). A coded span instead gets a BRACE in a right-hand gutter
 * spanning the range's vertical extent, with the annotation's code chips beside it.
 *
 * The COMPONENT measures pixel extents (DOM geometry: where a span's first and last
 * rects sit relative to the transcript container) — measurement is inherently DOM-bound.
 * This module owns everything after measurement, because vertical packing is the part
 * that silently breaks: two overlapping ranges whose blocks collide look like a CSS bug
 * and are actually a policy bug.
 *
 * Packing rule: blocks keep TEXT ORDER (sorted by the top of their braced range), and
 * each block sits at its range's top unless the previous block would overlap it, in
 * which case it is pushed down below that block plus a gap. Pushing DOWN (never up)
 * preserves the invariant that a block is never ABOVE the text it describes — a chip
 * you have to scroll up from its text to find reads as belonging to the previous
 * passage.
 */

/** One measured code-annotation range, in container-relative pixels. */
export type GutterInput = {
  id: string;
  /** Top of the braced text range. */
  top: number;
  /** Bottom of the braced text range (>= top). */
  bottom: number;
  /** Measured or estimated height of the chip block that will sit beside the brace. */
  blockHeight: number;
};

export type GutterBlock = {
  id: string;
  /** Brace extent — exactly the text range, never moved. */
  braceTop: number;
  braceBottom: number;
  /** Chip-block position after packing — starts at braceTop, pushed DOWN on collision. */
  blockTop: number;
};

/**
 * Pack chip blocks into the gutter. Braces always span their true text range; only the
 * chip BLOCKS move, and only downward. Deterministic: ties in `top` break by id so the
 * layout cannot reshuffle between renders.
 */
export function packGutter(inputs: GutterInput[], gap = 8): GutterBlock[] {
  const sorted = [...inputs].sort((a, b) =>
    a.top !== b.top ? a.top - b.top : a.id.localeCompare(b.id),
  );

  const out: GutterBlock[] = [];
  let floor = -Infinity; // bottom edge of the previously placed block + gap
  for (const item of sorted) {
    const blockTop = Math.max(item.top, floor);
    out.push({
      id: item.id,
      braceTop: item.top,
      braceBottom: Math.max(item.bottom, item.top),
      blockTop,
    });
    floor = blockTop + item.blockHeight + gap;
  }
  return out;
}

/**
 * Do two half-open character ranges on the SAME segment sequence overlap? Used to
 * decide whether a fresh selection may be merged into an existing annotation of the
 * same coder (identical anchors merge; merely-overlapping ones stay separate — a
 * different span is a different claim about where the evidence starts and stops).
 */
export function sameAnchor(
  a: { segmentId: string; endSegmentId: string | null; charStart: number; charEnd: number },
  b: { segmentId: string; endSegmentId: string | null; charStart: number; charEnd: number },
): boolean {
  return (
    a.segmentId === b.segmentId &&
    (a.endSegmentId ?? null) === (b.endSegmentId ?? null) &&
    a.charStart === b.charStart &&
    a.charEnd === b.charEnd
  );
}

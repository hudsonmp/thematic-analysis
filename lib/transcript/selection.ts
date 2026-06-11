// Pure helpers for sub-segment text-selection anchoring. No DOM, no I/O — safe to
// unit-test and to import from anywhere. The browser-coupled half (reading
// `window.getSelection()` and resolving a Range to char offsets within a
// segment's text node) lives in SessionPlayer; everything that can be expressed
// as string math lives here.
//
// Anchor model (the spike's recovery scheme): we store `char_start`/`char_end`
// WITHIN a single segment's text string, plus the exact `quote_text`, plus
// `prefix`/`suffix` (≤ CONTEXT_CHARS of surrounding text) so a future re-anchor
// pass can relocate the span if the transcript is lightly edited. SP-A handles
// single-segment selections only; multi-segment is SP-future.

/** Chars of surrounding context captured on each side for re-anchoring. */
export const CONTEXT_CHARS = 32;

/** A char-anchored span within one segment's text, with recovery context. */
export type TextAnchor = {
  /** Offset of the first selected char within the segment text (inclusive). */
  charStart: number;
  /** Offset just past the last selected char (exclusive). */
  charEnd: number;
  /** The exact selected substring, `text.slice(charStart, charEnd)`. */
  quoteText: string;
  /** Up to CONTEXT_CHARS of text immediately before `charStart`. */
  prefix: string;
  /** Up to CONTEXT_CHARS of text immediately after `charEnd`. */
  suffix: string;
};

/**
 * Build a {@link TextAnchor} from a segment's full text and a raw
 * `[start, end]` char offset pair (offsets WITHIN that text). The pair is
 * normalized defensively:
 *   - swapped so `charStart ≤ charEnd` (a backwards drag selects the same span),
 *   - clamped into `[0, text.length]` (a Range that ran past the text node — e.g.
 *     a trailing speaker label or whitespace node — can't produce out-of-range
 *     offsets).
 *
 * Returns `null` for an empty/collapsed selection (`charStart === charEnd` after
 * normalization), so callers can fall back to whole-segment anchoring.
 */
export function buildTextAnchor(text: string, rawStart: number, rawEnd: number): TextAnchor | null {
  const len = text.length;
  let start = clamp(Math.min(rawStart, rawEnd), 0, len);
  let end = clamp(Math.max(rawStart, rawEnd), 0, len);
  // Defensive: clamp may have collapsed an inverted/degenerate pair.
  if (start > end) [start, end] = [end, start];
  if (start === end) return null;
  return {
    charStart: start,
    charEnd: end,
    quoteText: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, Math.min(len, end + CONTEXT_CHARS)),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** A char-anchored highlight to render over a segment's text. */
export type Highlight = {
  /** The annotation this highlight belongs to (for click → rail selection). */
  annotationId: string;
  charStart: number;
  charEnd: number;
  kind: string;
};

/**
 * A piece of a segment's text after splitting it at every highlight boundary.
 * `highlightIds` is the (possibly empty) set of annotations covering this piece —
 * empty means plain text; ≥1 means it sits under one or more `<mark>`s. We keep
 * the full set so overlapping highlights can layer (the renderer picks a style
 * from the set; the click target resolves to the first id).
 */
export type TextPiece = {
  text: string;
  /** Annotation ids whose [charStart,charEnd) cover this piece. */
  highlightIds: string[];
  /** Distinct kinds present on this piece (e.g. 'code', 'quote') for styling. */
  kinds: string[];
};

/**
 * Split `text` into contiguous pieces at every highlight start/end boundary, so
 * each piece is uniformly covered by the same set of annotations. This is the
 * standard "sweep the boundaries" approach to rendering overlapping ranges: a
 * piece spanning two overlapping highlights carries BOTH ids, so the renderer can
 * layer them (spec: "if two overlap, layering is acceptable").
 *
 * Boundaries are clamped to `[0, text.length]` and a highlight with
 * `charStart >= charEnd` (empty) contributes no coverage. Pieces are returned in
 * text order and concatenate back to `text` exactly (no chars dropped or added).
 */
export function splitIntoPieces(text: string, highlights: Highlight[]): TextPiece[] {
  const len = text.length;
  if (len === 0) return [];

  // Collect every boundary inside (0, len): the cut points between pieces.
  const cuts = new Set<number>([0, len]);
  for (const h of highlights) {
    const s = clamp(h.charStart, 0, len);
    const e = clamp(h.charEnd, 0, len);
    if (s < e) {
      cuts.add(s);
      cuts.add(e);
    }
  }
  const bounds = [...cuts].sort((a, b) => a - b);

  const pieces: TextPiece[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i];
    const hi = bounds[i + 1];
    if (lo >= hi) continue;
    const ids: string[] = [];
    const kinds = new Set<string>();
    for (const h of highlights) {
      const s = clamp(h.charStart, 0, len);
      const e = clamp(h.charEnd, 0, len);
      // A highlight covers this piece iff it spans the whole [lo,hi) slice.
      if (s <= lo && e >= hi && s < e) {
        ids.push(h.annotationId);
        kinds.add(h.kind);
      }
    }
    pieces.push({ text: text.slice(lo, hi), highlightIds: ids, kinds: [...kinds] });
  }
  return pieces;
}

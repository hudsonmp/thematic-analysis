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

// ---------------------------------------------------------------------------
// Sentence boundaries (Method 3: sentence-level coding standardization).
//
// Coders may only highlight WHOLE sentences, so boundary jitter — the ~80% of
// disagreement diagnosed on session 548 — cannot arise (both coders inherit the
// same sentence units). `snapToSentences` expands a raw selection OUTWARD to the
// enclosing sentence boundaries; `sentenceSpans` is the shared splitter used by
// the coding surface to enumerate units. Both are pure string math.
//
// The splitter is deliberately simple and ASR-tolerant: a boundary is a
// sentence-final `.`, `!`, or `?` (optionally followed by closing quotes/
// brackets) and then whitespace or end-of-text. A cue with no terminal
// punctuation — common for ASR fragments — is one sentence. This is not a
// linguistic parser; it is a coding-unit segmenter, and its only correctness
// requirement is that every coder receives identical boundaries.
// ---------------------------------------------------------------------------

const SENTENCE_END = /[.!?]+["'”’)\]]*(?=\s|$)/g;

/**
 * The sentence spans of `text` as `[start, end)` char ranges that TILE the whole
 * string (every character belongs to exactly one span, including trailing
 * whitespace, so offsets round-trip). Whitespace-only or empty text yields a
 * single span covering it. Terminators stay with their sentence.
 */
export function sentenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  SENTENCE_END.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END.exec(text)) !== null) {
    // Include the terminator (and any trailing whitespace up to the next
    // sentence's first non-space char) in this span so spans tile contiguously.
    let end = m.index + m[0].length;
    while (end < text.length && /\s/.test(text[end])) end++;
    spans.push([start, end]);
    start = end;
  }
  if (start < text.length || spans.length === 0) spans.push([start, text.length]);
  return spans;
}

/**
 * Expand a raw `[start, end]` selection OUTWARD to the enclosing sentence
 * boundaries within `text`: `start` moves back to the start of the sentence it
 * falls in, `end` moves forward to the end of the sentence it falls in. A
 * selection already on boundaries is unchanged. Empty text → the input clamped.
 *
 * Applied per cue: for a multi-cue selection the caller snaps `start` within the
 * first cue's text and `end` within the last cue's text (the only two cues with
 * partial coverage; middle cues are always whole).
 */
export function snapToSentences(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const len = text.length;
  const s0 = clamp(Math.min(start, end), 0, len);
  const e0 = clamp(Math.max(start, end), 0, len);
  const spans = sentenceSpans(text);
  // Start → the start of the FIRST sentence whose end is past s0 (the sentence
  // s0 falls in; ties on a boundary keep the later sentence).
  let s = s0;
  for (const [b, x] of spans) {
    if (s0 < x) {
      s = b;
      break;
    }
  }
  // End → the end of the LAST sentence whose start is before e0 (the sentence e0
  // falls in; an e0 exactly on a boundary snaps to that boundary, not into the
  // next sentence). Read only the ORIGINAL e0 in the test, never the running e.
  let e = e0;
  for (const [b, x] of spans) {
    if (b < e0) e = x;
    else break;
  }
  if (e < s) e = s;
  return { start: s, end: e };
}

/** A char-anchored selection that may span MULTIPLE consecutive segments. The
 *  start lives at `startChar` within the FIRST covered segment, the end at
 *  `endChar` within the LAST. For a single-segment selection both offsets index
 *  the same segment and `startChar ≤ endChar`. */
export type MultiAnchor = {
  startChar: number;
  endChar: number;
  /** The exact selected text, segments joined by a single space (matching the
   *  rendered inter-cue spacing). */
  quoteText: string;
  /** Up to CONTEXT_CHARS before `startChar` in the first segment. */
  prefix: string;
  /** Up to CONTEXT_CHARS after `endChar` in the last segment. */
  suffix: string;
};

/**
 * Build a {@link MultiAnchor} from the texts of the covered segments (in order)
 * and the raw start/end char offsets. `segTexts[0]` is the FIRST covered segment
 * (where the selection starts at `rawStartChar`); `segTexts[last]` is the LAST
 * (where it ends at `rawEndChar`).
 *
 * Single-segment case (`segTexts.length === 1`): the two offsets index the same
 * text and are normalized (swapped so start ≤ end, clamped to `[0, len]`);
 * returns `null` for a collapsed/empty selection — identical to
 * {@link buildTextAnchor}, so the single-cue path is unchanged.
 *
 * Multi-segment case: offsets are NOT swapped (start is in the first segment, end
 * in the last — DOM Ranges are already in document order). `quoteText` is
 * `[first.slice(startChar), ...middleWhole, last.slice(0, endChar)]` joined by a
 * single space; `prefix`/`suffix` come from the first/last segment respectively.
 * Never null in the multi case (it always covers ≥1 whole middle cue or two
 * partial ends).
 */
export function buildMultiAnchor(
  segTexts: string[],
  rawStartChar: number,
  rawEndChar: number,
): MultiAnchor | null {
  if (segTexts.length === 0) return null;

  if (segTexts.length === 1) {
    const anchor = buildTextAnchor(segTexts[0], rawStartChar, rawEndChar);
    if (!anchor) return null;
    return {
      startChar: anchor.charStart,
      endChar: anchor.charEnd,
      quoteText: anchor.quoteText,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    };
  }

  const first = segTexts[0];
  const last = segTexts[segTexts.length - 1];
  const startChar = clamp(rawStartChar, 0, first.length);
  const endChar = clamp(rawEndChar, 0, last.length);

  const middle = segTexts.slice(1, -1);
  const quoteText = [first.slice(startChar), ...middle, last.slice(0, endChar)].join(' ');
  return {
    startChar,
    endChar,
    quoteText,
    prefix: first.slice(Math.max(0, startChar - CONTEXT_CHARS), startChar),
    suffix: last.slice(endChar, Math.min(last.length, endChar + CONTEXT_CHARS)),
  };
}

/** A char-anchored highlight to render over a segment's text. */
export type Highlight = {
  /** The annotation this highlight belongs to (for click → rail selection). */
  annotationId: string;
  charStart: number;
  charEnd: number;
  kind: string;
  /**
   * Optional explicit render color (a CSS color string). Used by FLAG highlights
   * (`kind:'flag'`), which paint the cue at a live observation's timestamp with
   * that flag's swatch color — the only highlight kind whose color is data-driven
   * rather than a fixed Tailwind class (codes=emerald, quotes/comments=yellow).
   * Carried through `splitIntoPieces` so the renderer can read it off a piece.
   */
  color?: string;
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

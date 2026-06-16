// Pure phrase search over transcript cues. No DOM, no I/O — unit-testable. Returns
// every case-insensitive occurrence of a query phrase as a (cue index, char range)
// so the player can paint match highlights (reusing the char-anchored highlight
// model) and step through matches in reading order.

/** One phrase occurrence: a `[charStart, charEnd)` span within cue `segIdx`. */
export type PhraseMatch = {
  /** Index into the (temporally-ordered) segments array — the same basis as
   *  `rowRefs`/`data-seg-idx`, so a match can be scrolled into view. */
  segIdx: number;
  charStart: number;
  charEnd: number;
};

/** Below this trimmed length a query matches nothing (a 1-char search floods the
 *  transcript with noise and isn't a "phrase"). */
export const MIN_QUERY_LEN = 2;

/**
 * Find every case-insensitive, NON-overlapping occurrence of `query` across the
 * cues' text, in reading order (cue order, then left-to-right within a cue). Char
 * offsets are into each cue's raw text, so they feed straight into the highlight
 * splitter. A blank/too-short query returns `[]`.
 *
 * Matching is plain substring (locale-default lowercasing) — not regex — so a query
 * with regex metacharacters is treated literally, which is what a reader expects.
 */
export function findPhraseMatches(
  segments: { text: string }[],
  query: string,
): PhraseMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY_LEN) return [];

  const out: PhraseMatch[] = [];
  for (let i = 0; i < segments.length; i++) {
    const hay = segments[i].text.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(q, from);
      if (idx === -1) break;
      out.push({ segIdx: i, charStart: idx, charEnd: idx + q.length });
      from = idx + q.length; // non-overlapping: resume past this match
    }
  }
  return out;
}

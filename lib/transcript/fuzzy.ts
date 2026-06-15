// Pure, dependency-free fuzzy matching for the coding-mode code picker. No DOM,
// no I/O, no external libraries (deliberately NOT fuse.js) — every function here
// is a deterministic pure function so the ranking is unit-testable and so the
// picker behaves identically server- and client-side.
//
// Why fuzzy at all: when coding a transcript a researcher reaches for a code by
// typing a *partial or approximate* description ("ws" for "Writing
// Specification", "spc" for "Specification"), not the exact label. We model this
// as a classic ordered-subsequence match — every typed char must appear in the
// candidate, in order — and then bias the score so that the matches a human would
// call "obvious" float to the top: prefix hits, word-start hits, and contiguous
// runs. Greedy left-to-right matching keeps the chosen indices (and therefore the
// score and any bolded chars) fully deterministic.

/** A scored fuzzy match: the original item plus its score and the matched indices
 *  (into the haystack string) so the caller can optionally bold matched chars. */
export type FuzzyMatch<T> = {
  item: T;
  score: number; // higher = better; 0 means "no match" (excluded)
  matchedIndices: number[]; // indices in the combined search string that matched
};

/** Per-matched-char point that every accepted char earns, before bonuses. */
const BASE_POINTS = 1;
/** Bonus when the matched char sits at haystack index 0 (start of the string).
 *  Largest bonus: a prefix hit is the strongest signal the user means this item. */
const START_BONUS = 5;
/** Bonus when the matched char begins a word (follows a separator or a
 *  camelCase hump) — "ws" → the W and S of "Writing Specification". */
const WORD_BOUNDARY_BONUS = 3;
/** Bonus when this matched char is adjacent to the previous matched char —
 *  rewards a contiguous run so "spec" beats a scattered s..p..e..c. */
const CONSECUTIVE_BONUS = 2;

/** Separator chars that mark a word boundary in the haystack. The char *after*
 *  any of these counts as a word start. */
const SEPARATORS = new Set([' ', '-', '_', '/']);

/**
 * Is `haystack[index]` the start of a word? True when it is preceded by a
 * separator (space, '-', '_', '/') OR sits at a lowercase→uppercase camelCase
 * transition (prev char lowercase, this char uppercase). Index 0 is handled
 * separately as the START bonus, so it is NOT reported here as a word boundary —
 * this keeps the two bonuses from stacking on the very first char.
 */
function isWordBoundary(haystack: string, index: number): boolean {
  if (index <= 0) return false;
  const prev = haystack[index - 1];
  if (SEPARATORS.has(prev)) return true;
  // camelCase hump: a lowercase char immediately followed by an uppercase char.
  const cur = haystack[index];
  const prevIsLower = prev >= 'a' && prev <= 'z';
  const curIsUpper = cur >= 'A' && cur <= 'Z';
  return prevIsLower && curIsUpper;
}

/**
 * Normalize a query for matching: trim the ends, then drop ALL internal
 * whitespace. Per the scoring contract, spaces in the query are not matched
 * against anything — they act as visual separators only — so collapsing a run of
 * spaces and removing them entirely are equivalent for matching purposes. The
 * remaining non-space chars are what must appear, in order, in the haystack.
 */
function queryChars(query: string): string {
  return query.replace(/\s+/g, '');
}

/**
 * Score a single query against a single haystack string. Case-insensitive,
 * ordered-subsequence match using GREEDY left-to-right selection: each query char
 * is matched to the first haystack occurrence at/after the previous match. Greedy
 * is deterministic and good enough for short code labels (an optimal DP would
 * rarely change the ordering and would cost clarity).
 *
 * Returns `null` when the (whitespace-stripped) query is not a subsequence of the
 * haystack. An empty query (after trimming) is the "match everything weakly"
 * case: it returns score 1 with no matched indices, so callers can keep all items
 * visible while nothing is typed.
 *
 * Scoring is the sum of per-char points: {@link BASE_POINTS} for every matched
 * char, plus {@link START_BONUS} at index 0, {@link WORD_BOUNDARY_BONUS} at a word
 * start, and {@link CONSECUTIVE_BONUS} when adjacent to the previous match. No
 * division — `fuzzyRank` uses haystack length only as a tie-breaker, so raw point
 * sums are compared directly.
 */
export function fuzzyScore(
  query: string,
  haystack: string,
): { score: number; matchedIndices: number[] } | null {
  const needle = queryChars(query);

  // Empty query: everything matches weakly (score 1, no specific chars matched).
  if (needle.length === 0) return { score: 1, matchedIndices: [] };

  const lowerNeedle = needle.toLowerCase();
  const lowerHay = haystack.toLowerCase();

  let score = 0;
  const matchedIndices: number[] = [];
  let searchFrom = 0; // next haystack index we may match at (enforces order)
  let prevMatch = -2; // index of the previous matched char (-2 ≠ any adjacency)

  for (let q = 0; q < lowerNeedle.length; q++) {
    const target = lowerNeedle[q];
    const at = lowerHay.indexOf(target, searchFrom);
    if (at === -1) return null; // not a subsequence → no match

    let points = BASE_POINTS;
    if (at === 0) {
      points += START_BONUS;
    } else if (isWordBoundary(haystack, at)) {
      // else-if: index 0 already earned START; don't also award word-boundary.
      points += WORD_BOUNDARY_BONUS;
    }
    if (at === prevMatch + 1) points += CONSECUTIVE_BONUS;

    score += points;
    matchedIndices.push(at);
    prevMatch = at;
    searchFrom = at + 1;
  }

  return { score, matchedIndices };
}

/**
 * Rank `items` against `query`, using `toSearchString(item)` as each item's
 * haystack. Returns every item that matches (score > 0) as a {@link FuzzyMatch},
 * sorted by:
 *   1. score DESC (best match first),
 *   2. haystack length ASC (shorter = tighter, so "spec" beats "specification"
 *      on equal scores),
 *   3. original index ASC (stable — equal-everything items keep input order).
 *
 * An empty or whitespace-only query is the "show everything" case: ALL items are
 * returned in their original order with score 1 (matching {@link fuzzyScore}'s
 * empty-query contract), so the picker lists the full codebook before the user
 * types.
 */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  toSearchString: (item: T) => string,
): FuzzyMatch<T>[] {
  // Empty/whitespace query: short-circuit to original order, uniform score 1.
  if (queryChars(query).length === 0) {
    return items.map((item) => ({ item, score: 1, matchedIndices: [] }));
  }

  // Carry the original index so the sort can break final ties stably. (Array
  // .sort is spec-stable in modern engines, but threading the index makes the
  // tie-break explicit and independent of that guarantee.)
  const matches: (FuzzyMatch<T> & { haystackLength: number; index: number })[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const haystack = toSearchString(item);
    const result = fuzzyScore(query, haystack);
    if (result === null || result.score <= 0) continue;
    matches.push({
      item,
      score: result.score,
      matchedIndices: result.matchedIndices,
      haystackLength: haystack.length,
      index: i,
    });
  }

  matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score; // score DESC
    if (a.haystackLength !== b.haystackLength) return a.haystackLength - b.haystackLength; // shorter first
    return a.index - b.index; // original order (stable)
  });

  // Strip the sort-only fields before returning the public shape.
  return matches.map(({ item, score, matchedIndices }) => ({ item, score, matchedIndices }));
}

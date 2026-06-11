/**
 * Pure, UI-agnostic predicates the matrix uses to decide which codes render.
 * Kept out of the React component so the filter logic is unit-testable in
 * isolation (no DOM, no server). Each predicate composes with the others by
 * logical AND in the view (a code shows iff it passes every active filter).
 */

/** The minimal code shape these filters read (a subset of `CodeWithRefs`). */
export type FilterableCode = {
  mnemonic: string;
  name: string;
  episodeIds: string[];
  labelIds: string[];
  citationIds: string[];
};

/**
 * Case-insensitive substring match over a code's mnemonic OR name. An
 * empty/whitespace query matches every code (the filter is "off"). Mirrors the
 * inline search the matrix has always had; extracted here so the text + episode
 * filters share one tested implementation.
 */
export function matchesQuery(code: Pick<FilterableCode, 'mnemonic' | 'name'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return code.mnemonic.toLowerCase().includes(q) || code.name.toLowerCase().includes(q);
}

/**
 * Whether a code is tagged with the given preset episode (Feature #10). A null
 * `episodeId` means "no episode filter applied" and matches every code (filter
 * off). Otherwise the code passes iff `episodeId` is among its `episodeIds`.
 */
export function matchesEpisode(code: Pick<FilterableCode, 'episodeIds'>, episodeId: string | null): boolean {
  if (!episodeId) return true;
  return code.episodeIds.includes(episodeId);
}

/**
 * Whether a code is tagged with the given label. A null `labelId` means "no
 * label filter applied" and matches every code (filter off). Otherwise the code
 * passes iff `labelId` is among its `labelIds`. Mirrors `matchesEpisode`; the
 * label axis (categorical / "what kind") is orthogonal to the episode axis.
 */
export function matchesLabel(code: Pick<FilterableCode, 'labelIds'>, labelId: string | null): boolean {
  if (!labelId) return true;
  return code.labelIds.includes(labelId);
}

/**
 * Whether a code is linked to the given citation (the built-in, virtual
 * "Citations" facet — backed by cb_code_citations regardless of link role). A
 * null `citationId` means "no citation filter applied" and matches every code
 * (filter off). Otherwise the code passes iff `citationId` is among its
 * `citationIds`. Mirrors `matchesEpisode`/`matchesLabel`; the citation axis
 * (which papers a code is grounded in) is orthogonal to both.
 */
export function matchesCitation(
  code: Pick<FilterableCode, 'citationIds'>,
  citationId: string | null,
): boolean {
  if (!citationId) return true;
  return code.citationIds.includes(citationId);
}

/**
 * The composed matrix filter: a code is visible iff it matches the free-text
 * query AND the (optional) episode filter AND the (optional) label filter AND
 * the (optional) citation filter. This is the single source of truth the matrix
 * consults before pivoting codes onto the grid.
 */
export function isCodeVisible<C extends FilterableCode>(
  code: C,
  query: string,
  episodeId: string | null,
  labelId: string | null,
  citationId: string | null = null,
): boolean {
  return (
    matchesQuery(code, query) &&
    matchesEpisode(code, episodeId) &&
    matchesLabel(code, labelId) &&
    matchesCitation(code, citationId)
  );
}

/** Apply {@link isCodeVisible} across a list, preserving order. */
export function filterCodes<C extends FilterableCode>(
  codes: readonly C[],
  query: string,
  episodeId: string | null,
  labelId: string | null,
  citationId: string | null = null,
): C[] {
  return codes.filter((c) => isCodeVisible(c, query, episodeId, labelId, citationId));
}

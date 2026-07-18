// ---------------------------------------------------------------------------
// Slug normalization + bulk-row validation — pure helpers for Codebook bulk
// entry.
//
// `cb_codes.mnemonic` (the SLUG) is the sole human identifier for a code: NOT
// NULL with a UNIQUE (codebook_id, mnemonic) constraint. The researcher TYPES
// the slug directly (there is no `name` to derive it from); `normalizeSlug`
// canonicalizes what they type into an UPPER-KEBAB form so casing/spacing slips
// don't mint accidental near-duplicates. `uniqueMnemonic` remains available for
// the server-side race-safety path (createCode `autoUniqueMnemonic`).
//
// These are PURE (no I/O) so they unit-test cleanly; the server action seeds the
// "used" set from the codebook's existing mnemonics and threads it through the
// batch.
// ---------------------------------------------------------------------------

/** A single spreadsheet row of the bulk-entry grid (pre-validation). The slug is
 *  the code's mnemonic (its sole identifier), typed directly by the researcher. */
export type CodebookRow = {
  slug: string;
  definition: string;
};

/**
 * Normalize a typed slug into an UPPER-KEBAB mnemonic: letters/digits kept,
 * everything else collapsed to single dashes, trimmed, upper-cased, capped at
 * `maxLen`. Returns `'CODE'` as a last resort when the input has no slug-able
 * characters (e.g. all punctuation) so the result is never empty.
 */
export function normalizeSlug(input: string, maxLen = 24): string {
  const slug = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, ''); // a trailing dash left by the slice
  return slug || 'CODE';
}

/**
 * Make `base` unique against `used` (case-sensitive, matching the DB's exact
 * UNIQUE constraint) by appending `-2`, `-3`, … until free. Does NOT mutate
 * `used` — the caller adds the returned value once committed.
 */
export function uniqueMnemonic(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * A row is non-empty iff either of its two cells has content. The always-present
 * trailing blank row in the grid is empty by this test and is skipped on commit.
 */
export function isRowEmpty(row: CodebookRow): boolean {
  return !row.slug.trim() && !row.definition.trim();
}

/** A validated, ready-to-create row: a resolved (normalized, unique) mnemonic +
 *  trimmed definition. */
export type ResolvedRow = {
  /** 0-based index of the row in the ORIGINAL input array (for error reporting). */
  index: number;
  mnemonic: string;
  definition: string;
};

export type ValidationError = { index: number; message: string };

/**
 * Validate + resolve a batch of grid rows into create-ready rows.
 *
 * - Empty rows (both cells blank) are dropped silently (the trailing blank row).
 * - A row with content but no slug is an error (the slug is the required cell).
 * - The typed slug is NORMALIZED (`normalizeSlug`) — the normalized value is the
 *   mnemonic. A slug that collides with one already used in this batch (or the
 *   codebook) is an error — we surface it rather than silently auto-suffixing,
 *   because the slug is the code's sole identifier and two codes the researcher
 *   named the same thing is a naming decision to make, not a conflict to paper over.
 *
 * `existingMnemonics` should be the codebook's current `cb_codes.mnemonic` set
 * (case-sensitive). Returns the resolved rows (in input order, empties removed)
 * and any per-row errors; the caller creates the resolved rows and keeps the
 * errored rows in the grid.
 */
export function resolveRows(
  rows: CodebookRow[],
  existingMnemonics: ReadonlySet<string>,
): { resolved: ResolvedRow[]; errors: ValidationError[] } {
  const resolved: ResolvedRow[] = [];
  const errors: ValidationError[] = [];
  // Running set of taken mnemonics: existing codebook keys + this-batch keys.
  const used = new Set<string>(existingMnemonics);

  rows.forEach((row, index) => {
    if (isRowEmpty(row)) return;

    const slugRaw = row.slug.trim();
    const definition = row.definition.trim();

    if (!slugRaw) {
      errors.push({ index, message: 'A slug is required.' });
      return;
    }

    const mnemonic = normalizeSlug(slugRaw);
    if (used.has(mnemonic)) {
      errors.push({ index, message: `Slug "${mnemonic}" already in use.` });
      return;
    }

    used.add(mnemonic);
    resolved.push({ index, mnemonic, definition });
  });

  return { resolved, errors };
}

/**
 * Detect "state 3" rows: a row that carries SIDE-CAR writes (label tags and/or
 * facet selections) but whose CORE cells (slug/definition) are both blank, so
 * `resolveRows` judged it empty and dropped it SILENTLY — neither resolved nor
 * errored.
 *
 * Such a row was submitted by the client (its `isGridRowEmpty` counts labels /
 * facets, so the row is non-empty there) but produces NO code server-side, and —
 * without this check — no error either, so the researcher's label / facet tags
 * vanish on the success reset with zero feedback. This helper closes that gap: it
 * returns the original-index errors the bulk-create action must append so the
 * write-bearing-but-slugless rows surface as "a slug is required" and are kept in
 * the grid for the researcher to name and resubmit.
 *
 * It is the PURE decision core (no I/O) so it unit-tests cleanly; the action
 * computes `writeBearingIndices` from `labelWritesByIndex` ∪ keys of
 * `facetWritesByIndex` and feeds it the `resolved` + `errors` of `resolveRows`.
 *
 * An index counts as needing the error iff it bears writes AND is neither resolved
 * (a code was created — labels/facets applied) NOR already errored (e.g. a content
 * row missing a slug, or a duplicate slug — already surfaced). De-duped + in
 * ascending index order for stable reporting.
 */
export function writeOnlyRowErrors(
  writeBearingIndices: Iterable<number>,
  resolved: ResolvedRow[],
  errors: ValidationError[],
): ValidationError[] {
  const accounted = new Set<number>();
  for (const r of resolved) accounted.add(r.index);
  for (const e of errors) accounted.add(e.index);

  const out: ValidationError[] = [];
  const seen = new Set<number>();
  for (const index of writeBearingIndices) {
    if (accounted.has(index) || seen.has(index)) continue;
    seen.add(index);
    out.push({ index, message: 'A slug is required to save its labels/facets.' });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Mnemonic derivation + bulk-row validation — pure helpers for Codebook bulk
// entry.
//
// `cb_codes.mnemonic` is NOT NULL with a UNIQUE (codebook_id, mnemonic)
// constraint. The spreadsheet bulk-entry surface lets a researcher leave the
// mnemonic blank (only Name is required), so we must synthesize a NON-EMPTY,
// codebook-UNIQUE mnemonic for each such row — otherwise the second blank-
// mnemonic row in a batch would collide with the first on `''`.
//
// `deriveMnemonic` slugifies the name; `uniqueMnemonic` makes that slug unique
// against a set of already-used mnemonics (existing codebook mnemonics + the
// mnemonics assigned earlier in THIS batch) by appending `-2`, `-3`, … . These
// are PURE (no I/O) so they unit-test cleanly; the server action threads the
// "used" set through the batch and seeds it from the codebook's existing codes.
// ---------------------------------------------------------------------------

/** A single spreadsheet row of the bulk-entry grid (pre-validation). */
export type CodebookRow = {
  name: string;
  mnemonic: string;
  definition: string;
};

/**
 * Slugify a code name into an UPPER-KEBAB mnemonic stub: letters/digits kept,
 * everything else collapsed to single dashes, trimmed, upper-cased, capped at
 * `maxLen`. Returns `'CODE'` as a last resort when the name has no slug-able
 * characters (e.g. all punctuation) so the result is never empty.
 */
export function deriveMnemonic(name: string, maxLen = 24): string {
  const slug = name
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
 * A row is non-empty iff any of its three cells has content. The always-present
 * trailing blank row in the grid is empty by this test and is skipped on commit.
 */
export function isRowEmpty(row: CodebookRow): boolean {
  return !row.name.trim() && !row.mnemonic.trim() && !row.definition.trim();
}

/** A validated, ready-to-create row: trimmed cells + a resolved unique mnemonic. */
export type ResolvedRow = {
  /** 0-based index of the row in the ORIGINAL input array (for error reporting). */
  index: number;
  name: string;
  mnemonic: string;
  definition: string;
};

export type ValidationError = { index: number; message: string };

/**
 * Validate + resolve a batch of grid rows into create-ready rows.
 *
 * - Empty rows (all cells blank) are dropped silently (the trailing blank row).
 * - A row with content but no Name is an error (Name is the only required cell).
 * - For a row with a blank mnemonic, derive one from the name and make it unique
 *   against `existingMnemonics` PLUS every mnemonic already assigned in this
 *   batch (explicit or derived), so no two rows collide on the UNIQUE constraint.
 * - An explicit mnemonic that duplicates one already used in this batch (or the
 *   codebook) is likewise an error — we surface it rather than silently mangling
 *   the researcher's chosen key.
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

    const name = row.name.trim();
    const mnemonicRaw = row.mnemonic.trim();
    const definition = row.definition.trim();

    if (!name) {
      errors.push({ index, message: 'Name is required.' });
      return;
    }

    let mnemonic: string;
    if (mnemonicRaw) {
      if (used.has(mnemonicRaw)) {
        errors.push({ index, message: `Mnemonic "${mnemonicRaw}" already in use.` });
        return;
      }
      mnemonic = mnemonicRaw;
    } else {
      mnemonic = uniqueMnemonic(deriveMnemonic(name), used);
    }

    used.add(mnemonic);
    resolved.push({ index, name, mnemonic, definition });
  });

  return { resolved, errors };
}

/**
 * Detect "state 3" rows: a row that carries SIDE-CAR writes (label tags and/or
 * facet selections) but whose three CORE cells (name/mnemonic/definition) are all
 * blank, so `resolveRows` judged it empty and dropped it SILENTLY — neither
 * resolved nor errored.
 *
 * Such a row was submitted by the client (its `isGridRowEmpty` counts labels /
 * facets, so the row is non-empty there) but produces NO code server-side, and —
 * without this check — no error either, so the researcher's label / facet tags
 * vanish on the success reset with zero feedback. This helper closes that gap: it
 * returns the original-index errors the bulk-create action must append so the
 * write-bearing-but-nameless rows surface as "Name is required" and are kept in
 * the grid for the researcher to name and resubmit.
 *
 * It is the PURE decision core (no I/O) so it unit-tests cleanly; the action
 * computes `writeBearingIndices` from `labelWritesByIndex` ∪ keys of
 * `facetWritesByIndex` and feeds it the `resolved` + `errors` of `resolveRows`.
 *
 * An index counts as needing the error iff it bears writes AND is neither resolved
 * (a code was created — labels/facets applied) NOR already errored (e.g. a content
 * row missing a name, or a duplicate mnemonic — already surfaced). De-duped + in
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
    out.push({ index, message: 'Name is required to save its labels/facets.' });
  }
  return out.sort((a, b) => a.index - b.index);
}

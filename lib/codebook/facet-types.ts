// ---------------------------------------------------------------------------
// Facet TYPES — the small, PURE core of "how a facet is carried by a code".
//
// A facet's `type` (migration 22, cb_facets.type) fixes its storage + UI:
//   * 'enum'      — value-bearing (cb_facet_values). cardinality decides how many
//                   values a code may carry: 'single' (pick one) / 'multi' (pick
//                   many). Code↔value lives in cb_code_facet_values.
//   * 'boolean'   — no values; a yes/no per code in cb_code_facet_fields.bool_value.
//   * 'open_text' — no values; a free-text note per code in
//                   cb_code_facet_fields.text_value.
//
// This module is PURE (no I/O, no React) so it unit-tests cleanly and is the
// single source of truth shared by the server actions, the FacetEditor (scheme),
// and the FacetTagger (per-code). The DB stores `type` as free `text` under a
// CHECK constraint; `isFacetType` / `coerceFacetType` narrow that `string` back
// to the union at the app boundary.
// ---------------------------------------------------------------------------

/** The three facet kinds. Mirrors the cb_facets.type CHECK constraint. */
export type FacetType = 'enum' | 'boolean' | 'open_text';

export const FACET_TYPES: readonly FacetType[] = ['enum', 'boolean', 'open_text'] as const;

/** Default for any facet whose `type` is absent/unknown — matches the column
 *  default and preserves pre-migration ("everything is enum") behavior. */
export const DEFAULT_FACET_TYPE: FacetType = 'enum';

/** Runtime narrowing of a raw DB `string` to the FacetType union. */
export function isFacetType(value: string): value is FacetType {
  return (FACET_TYPES as readonly string[]).includes(value);
}

/** Coerce an arbitrary `type` string from the DB to a FacetType, falling back to
 *  the default for anything unrecognized (forward-compatible + null-safe). */
export function coerceFacetType(value: string | null | undefined): FacetType {
  return value && isFacetType(value) ? value : DEFAULT_FACET_TYPE;
}

/** Only enum facets carry cb_facet_values. The scheme editor shows the value +
 *  cardinality controls iff this is true; the matrix pivots on enum facets only. */
export function facetHasValues(type: FacetType): boolean {
  return type === 'enum';
}

/**
 * The UI render mode for a facet on a code card, collapsing (type, cardinality)
 * into the one control the tagger should draw:
 *   - 'enum-single' → <select> of values + an "Other…" inline-add entry
 *   - 'enum-multi'  → multi-select chips (independent toggles)
 *   - 'boolean'     → a tri-state yes/no/unset control
 *   - 'open-text'   → a one-line debounced text input
 * cardinality is only consulted for enum; boolean/open_text ignore it.
 */
export type FacetRenderMode = 'enum-single' | 'enum-multi' | 'boolean' | 'open-text';

export function facetRenderMode(
  type: FacetType,
  cardinality: 'single' | 'multi',
): FacetRenderMode {
  switch (type) {
    case 'boolean':
      return 'boolean';
    case 'open_text':
      return 'open-text';
    case 'enum':
    default:
      return cardinality === 'multi' ? 'enum-multi' : 'enum-single';
  }
}

/**
 * Slugify a free-typed value LABEL into a machine `key` for the inline "Other…"
 * add path (cb_facet_values.key is NOT NULL). Lowercase, non-alphanumerics
 * collapsed to single dashes, trimmed; falls back to 'value' when the label has
 * no slug-able characters so the key is never empty. (Lower-kebab matches the
 * facet/value `key` convention surfaced in the scheme editor copy — distinct
 * from the UPPER-kebab code mnemonics in lib/codebook/mnemonic.ts.)
 */
export function slugifyValueKey(label: string, maxLen = 40): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, ''); // a trailing dash left by the slice
  return slug || 'value';
}

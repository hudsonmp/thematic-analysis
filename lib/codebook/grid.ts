// ---------------------------------------------------------------------------
// Pure grid logic for the scheme-derived Codebook bulk-entry spreadsheet.
//
// The grid's COLUMNS are derived from the codebook's scheme: three core columns
// (Name / Mnemonic / Definition) followed by one column per facet, rendered by
// the facet's TYPE (`facetRenderMode`). A grid ROW therefore carries the three
// core cells PLUS a per-facet value bag.
//
// This module is PURE (no I/O, no React) so it unit-tests cleanly and is the
// single source of truth shared by the client grid and the bulk-create action:
//   - `FacetCell`           — the per-facet value a row holds, by render mode;
//   - `rowToFacetWrites`    — map a row's facet bag into the discrete writes the
//                             server action must perform (enum value ids +
//                             boolean/open_text fields), dropping unset cells;
//   - `bufferedRowCount`    — the auto-extend buffer math (how many rows to keep
//                             so there is always a comfortable empty tail);
//   - `nextRowFocusIndex`   — the Enter-key target (Name cell of the next row).
//
// `RowData.core` reuses `CodebookRow` (lib/codebook/mnemonic.ts) so the existing
// `resolveRows` validation/mnemonic-derivation path is unchanged.
// ---------------------------------------------------------------------------

import type { CodebookRow } from './mnemonic';
import { isRowEmpty } from './mnemonic';
import type { FacetRenderMode } from './facet-types';

/**
 * A facet column descriptor the grid renders and the row payload keys off. It is
 * the minimal projection of a `FacetWithValues` the pure layer needs: the facet
 * id, its render mode, and (for enum facets) its value ids — enough to know how
 * to render the header/cell and how to translate a cell into DB writes.
 */
export type FacetColumn = {
  facetId: string;
  label: string;
  mode: FacetRenderMode;
  /** enum value ids on this facet (empty for boolean / open_text). */
  valueIds: string[];
};

/**
 * The value a single row holds on a single facet, discriminated by render mode:
 *   - enum-single → at most one selected value id (`valueIds` length 0 or 1);
 *   - enum-multi  → any number of selected value ids;
 *   - boolean     → `bool` is true / false / null (null = unset, no write);
 *   - open-text   → `text` free string ('' = unset, no write).
 * A FACET CELL with no selection (empty `valueIds`, null `bool`, empty `text`) is
 * "unset" and produces no write.
 */
export type FacetCell =
  | { kind: 'enum'; valueIds: string[] }
  | { kind: 'boolean'; bool: boolean | null }
  | { kind: 'open_text'; text: string };

/** A full grid row: the three core cells + a per-facet cell map keyed by facetId. */
export type RowData = {
  core: CodebookRow;
  facets: Record<string, FacetCell>;
};

/** Construct the empty (unset) cell for a column's render mode. */
export function emptyFacetCell(mode: FacetRenderMode): FacetCell {
  switch (mode) {
    case 'boolean':
      return { kind: 'boolean', bool: null };
    case 'open-text':
      return { kind: 'open_text', text: '' };
    case 'enum-single':
    case 'enum-multi':
    default:
      return { kind: 'enum', valueIds: [] };
  }
}

/** A fresh, fully-empty row for the given facet columns. */
export function emptyRow(columns: FacetColumn[]): RowData {
  const facets: Record<string, FacetCell> = {};
  for (const col of columns) facets[col.facetId] = emptyFacetCell(col.mode);
  return { core: { name: '', mnemonic: '', definition: '' }, facets };
}

/** Whether a facet cell carries any value (would produce a write). */
export function isFacetCellSet(cell: FacetCell | undefined): boolean {
  if (!cell) return false;
  switch (cell.kind) {
    case 'enum':
      return cell.valueIds.length > 0;
    case 'boolean':
      return cell.bool !== null;
    case 'open_text':
      return cell.text.trim().length > 0;
  }
}

/**
 * A row is empty iff its three core cells are blank AND no facet cell is set.
 * The always-present trailing buffer rows are empty by this test and skipped on
 * commit. (A row with ONLY facet data but no name is NOT empty — it is surfaced
 * by `resolveRows` as a "Name is required" error rather than silently dropped,
 * so the researcher does not lose facet selections they made on a nameless row.)
 */
export function isGridRowEmpty(row: RowData): boolean {
  if (!isRowEmpty(row.core)) return false;
  for (const facetId in row.facets) {
    if (isFacetCellSet(row.facets[facetId])) return false;
  }
  return true;
}

/**
 * The discrete facet WRITES a single row implies, split by storage:
 *   - `enumValueIds` → cb_code_facet_values (one row's worth, across enum facets,
 *     de-duped). Set via the enum value setter after the code is created.
 *   - `fields`       → cb_code_facet_fields, one per non-unset boolean/open_text
 *     facet ({ facetId, bool_value? | text_value? }). Unset cells are omitted.
 */
export type RowFacetWrites = {
  enumValueIds: string[];
  fields: { facetId: string; bool_value?: boolean | null; text_value?: string | null }[];
};

/**
 * Translate a row's facet bag into the writes the server action performs. Only
 * SET cells contribute: enum cells contribute their value ids (flattened +
 * de-duped across all enum facets, since cb_code_facet_values is keyed on
 * (code_id, facet_value_id) regardless of facet); boolean cells contribute a
 * `bool_value` field; open_text cells contribute a trimmed `text_value` field.
 * `columns` fixes which facets exist (a stray key in `row.facets` not present in
 * `columns` is ignored, so a removed facet can't leak a write).
 */
export function rowToFacetWrites(row: RowData, columns: FacetColumn[]): RowFacetWrites {
  const enumValueIds: string[] = [];
  const fields: RowFacetWrites['fields'] = [];

  for (const col of columns) {
    const cell = row.facets[col.facetId];
    if (!isFacetCellSet(cell)) continue;
    switch (cell.kind) {
      case 'enum':
        enumValueIds.push(...cell.valueIds);
        break;
      case 'boolean':
        fields.push({ facetId: col.facetId, bool_value: cell.bool });
        break;
      case 'open_text':
        fields.push({ facetId: col.facetId, text_value: cell.text.trim() });
        break;
    }
  }

  return { enumValueIds: [...new Set(enumValueIds)], fields };
}

// ---------------------------------------------------------------------------
// Auto-extend buffer + keyboard navigation (pure index math)
// ---------------------------------------------------------------------------

/** Default size of the empty tail kept below the last filled row, and the floor
 *  for the initial render (~500 ready rows). */
export const DEFAULT_BUFFER = 50;
export const INITIAL_ROWS = 500;

/**
 * How many rows the grid should hold so there is always a comfortable empty tail
 * below the last FILLED row. `lastFilledIndex` is the 0-based index of the last
 * non-empty row (or -1 if none filled). The grid never shrinks below `minRows`
 * (the initial ~500), and otherwise keeps at least `buffer` empty rows after the
 * last filled one. Returns the TARGET total row count.
 *
 * Examples (minRows=500, buffer=50):
 *   - nothing filled (lastFilledIndex=-1) → 500
 *   - filled up to index 480              → max(500, 480+1+50)=531
 *   - filled up to index 700             → 751
 */
export function bufferedRowCount(
  lastFilledIndex: number,
  minRows = INITIAL_ROWS,
  buffer = DEFAULT_BUFFER,
): number {
  const need = lastFilledIndex + 1 + buffer;
  return Math.max(minRows, need);
}

/**
 * The index of the last filled (non-empty) row in `rows`, or -1 if every row is
 * empty. Drives `bufferedRowCount` for auto-extend.
 */
export function lastFilledIndex(rows: RowData[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (!isGridRowEmpty(rows[i])) return i;
  }
  return -1;
}

/**
 * The Enter-key focus target: the index of the NEXT row (whose Name cell should
 * receive focus). Pressing Enter on the last row returns `currentIndex + 1`,
 * which the caller treats as "append a row, then focus it" (the grid auto-
 * extends, so the next row always exists after the count is recomputed).
 * Clamping is the caller's job; this is the pure intent.
 */
export function nextRowFocusIndex(currentIndex: number): number {
  return currentIndex + 1;
}

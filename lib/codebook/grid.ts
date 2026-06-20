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

/** A full grid row: the three core cells + a per-facet cell map keyed by facetId
 *  + the LABEL ids the row is tagged with (the categorical "what kind" axis,
 *  cb_code_labels — independent of facets; see app/actions/labels.ts). Labels are
 *  a flat id list rather than a per-column cell bag because they are one
 *  multi-select over the codebook's (nested) label vocabulary, not one column per
 *  facet. Empty (`[]`) is "untagged" and produces no write. */
export type RowData = {
  core: CodebookRow;
  facets: Record<string, FacetCell>;
  labels: string[];
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

/** A fresh, fully-empty row for the given facet columns (no labels tagged). */
export function emptyRow(columns: FacetColumn[]): RowData {
  const facets: Record<string, FacetCell> = {};
  for (const col of columns) facets[col.facetId] = emptyFacetCell(col.mode);
  return { core: { name: '', mnemonic: '', definition: '' }, facets, labels: [] };
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
 * A row is empty iff its three core cells are blank AND no facet cell is set AND
 * no label is tagged. The always-present trailing buffer rows are empty by this
 * test and skipped on commit. (A row with ONLY facet data or ONLY labels but no
 * name is NOT empty — it is surfaced by `resolveRows` as a "Name is required"
 * error rather than silently dropped, so the researcher does not lose the facet
 * selections or label tags they made on a nameless row.)
 */
export function isGridRowEmpty(row: RowData): boolean {
  if (!isRowEmpty(row.core)) return false;
  if (row.labels.length > 0) return false;
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

/**
 * Assemble the per-row LABEL writes the bulk-create action applies, keyed by each
 * row's submit index (its 0-based position in the submitted batch — the SAME
 * index `facetWritesByIndex` uses, so the two maps stay aligned). For each
 * submitted row, the row's label ids are de-duped (the junction PK is
 * (code_id, label_id)); a row with NO labels is OMITTED entirely (no key) so the
 * action makes no `setCodeLabels` call for it. The result is the
 * `labelWritesByIndex: Record<number, string[]>` `createCodesBulkWithFacets`
 * expects. PURE (no I/O), mirroring `rowToFacetWrites` — the client builds it,
 * the action just applies it.
 */
export function assembleLabelWrites(
  submitted: { index: number; row: RowData }[],
): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  submitted.forEach(({ index, row }) => {
    const ids = [...new Set(row.labels)];
    if (ids.length > 0) out[index] = ids;
  });
  return out;
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

// ---------------------------------------------------------------------------
// Arrow-key cell navigation (pure target-cell computation)
//
// The grid is a spreadsheet of CELLS addressed by (rowIndex, colIndex):
//   col 0 = Name, col 1 = Mnemonic, col 2 = Definition, col 3.. = one per facet.
// `CORE_COL_COUNT` is the count of fixed leading columns; `colCount` for a grid
// is therefore `CORE_COL_COUNT + facetColumns.length`.
//
// `arrowTargetCell` is the single source of truth for "where does an arrow key
// move focus?", unit-tested in isolation. It is PURE: it takes the current cell,
// the pressed key, and the caret situation, and returns the next cell or null
// (null = do nothing / let the event fall through to the browser, e.g. moving
// the caret inside a text field). The component wires the result to focus the
// right element for the target cell's type and to auto-extend the grid.
// ---------------------------------------------------------------------------

/** Number of fixed leading columns before the facet columns (Name/Mnemonic/Definition). */
export const CORE_COL_COUNT = 3;

/** The four arrow keys this navigation responds to. */
export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/** A cell address in the grid. */
export type CellPos = { row: number; col: number };

/**
 * Inputs to the pure arrow-navigation decision:
 *   - `row`/`col`     — the currently focused cell.
 *   - `key`           — the arrow key pressed.
 *   - `isTextCell`    — whether the FOCUSED cell is a free-text field (Name /
 *                       Mnemonic / Definition / open-text facet). Only text
 *                       cells gate Left/Right on the caret; non-text cells
 *                       (select, yes/no, chips) move cells immediately.
 *   - `caretAtStart`  — for a text cell, whether the caret sits at offset 0 with
 *                       no selection (so ArrowLeft should leave the field).
 *   - `caretAtEnd`    — for a text cell, whether the caret sits at the end with
 *                       no selection (so ArrowRight should leave the field).
 *   - `colCount`      — total columns (CORE_COL_COUNT + facet columns).
 *   - `rowCount`      — current total rows (the target may exceed this on Down,
 *                       signalling the caller to auto-extend; see below).
 */
export type ArrowNavInput = {
  row: number;
  col: number;
  key: ArrowKey;
  isTextCell: boolean;
  caretAtStart: boolean;
  caretAtEnd: boolean;
  colCount: number;
  rowCount: number;
};

/**
 * Compute the target cell for an arrow key, or null to take no action (let the
 * browser handle the key — e.g. move the caret within a text field, or stay put
 * at a grid edge). Spreadsheet semantics:
 *
 *   - DOWN  → same column, next row. ALWAYS moves (never null while in-grid);
 *     if it passes the last row it returns `row+1` anyway — the caller treats a
 *     target row >= rowCount as "extend the grid, then focus" (exactly like
 *     Enter via `focusName`). So Down never returns null.
 *   - UP    → same column, previous row. Null at row 0 (nowhere above).
 *   - LEFT  → previous column, same row. For a TEXT cell, only when the caret is
 *     at the start (otherwise null, so the caret moves within the text). Null at
 *     col 0 (nowhere to the left).
 *   - RIGHT → next column, same row. For a TEXT cell, only when the caret is at
 *     the end (otherwise null). Null at the last column.
 *
 * Up/Down do NOT depend on caret position: a spreadsheet always moves the
 * selection vertically. (For native <select> the component must only call this
 * with Up/Down when the select is CLOSED, since an open select uses Up/Down to
 * change its option — see CodebookEntry.)
 */
export function arrowTargetCell(input: ArrowNavInput): CellPos | null {
  const { row, col, key, isTextCell, caretAtStart, caretAtEnd, colCount } = input;

  switch (key) {
    case 'ArrowDown':
      // Always move down; row+1 may exceed rowCount → caller auto-extends.
      return { row: row + 1, col };
    case 'ArrowUp':
      return row > 0 ? { row: row - 1, col } : null;
    case 'ArrowLeft':
      if (col <= 0) return null;
      // Text cells only jump when the caret is already at the field start.
      if (isTextCell && !caretAtStart) return null;
      return { row, col: col - 1 };
    case 'ArrowRight':
      if (col >= colCount - 1) return null;
      if (isTextCell && !caretAtEnd) return null;
      return { row, col: col + 1 };
    default:
      return null;
  }
}

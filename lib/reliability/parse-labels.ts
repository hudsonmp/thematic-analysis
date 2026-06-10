import type { LabelPair } from '@/lib/reliability/stats';

/**
 * Pure label-table parser (Task 12, Part B).
 *
 * Researchers paste a small two-coder agreement table as CSV or TSV. We accept
 * either delimiter (auto-detected per line: a tab if present, else a comma) and
 * an OPTIONAL header row. Each data row is `unit, labelA, labelB`; a 2-column
 * row is `labelA, labelB` with the 1-based row index used as the synthetic unit
 * id. Cells are trimmed; blank lines are skipped.
 *
 * Header detection is intentionally conservative — a single-category degenerate
 * input like `yes,yes / yes,yes` must NOT be mistaken for a header. We only skip
 * the first row if its label cells match a KNOWN header vocabulary
 * (case-insensitively): the literal column names ("unit"/"coderA"/"coderB") or
 * the short forms ("a"/"b"). Real category labels ("yes"/"no"/code mnemonics)
 * never collide with that set, so data is never silently dropped.
 *
 * Returns the `LabelPair[]` (input to every stat in `@/lib/reliability/stats`)
 * and the parallel `units` array of unit ids.
 */

const HEADER_TOKENS = new Set(['unit', 'codera', 'coderb', 'coder_a', 'coder_b', 'a', 'b']);

function splitLine(line: string): string[] {
  const delimiter = line.includes('\t') ? '\t' : ',';
  return line.split(delimiter).map((cell) => cell.trim());
}

/** A row is a header iff its LABEL cells (the last two columns) are all known
 *  header tokens. We key off the label columns, not the unit column, so an
 *  arbitrary unit id in the first data row can't trip detection. */
function isHeaderRow(cells: string[]): boolean {
  const labelCells = cells.length >= 3 ? cells.slice(1, 3) : cells.slice(0, 2);
  if (labelCells.length < 2) return false;
  return labelCells.every((c) => HEADER_TOKENS.has(c.toLowerCase()));
}

export function parseLabelTable(text: string): { pairs: LabelPair[]; units: string[] } {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(splitLine);

  if (rows.length === 0) return { pairs: [], units: [] };

  const dataRows = isHeaderRow(rows[0]) ? rows.slice(1) : rows;

  const pairs: LabelPair[] = [];
  const units: string[] = [];

  dataRows.forEach((cells, i) => {
    let unit: string;
    let a: string;
    let b: string;
    if (cells.length >= 3) {
      [unit, a, b] = cells;
    } else if (cells.length === 2) {
      // 2-column fallback: labelA, labelB; synthesize a 1-based unit index.
      unit = String(i + 1);
      [a, b] = cells;
    } else {
      // A row with <2 cells carries no pair; skip it (it can't form a LabelPair).
      return;
    }
    pairs.push([a, b]);
    units.push(unit);
  });

  return { pairs, units };
}

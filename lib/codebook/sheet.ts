/**
 * sheet — PURE column layout for the printable codebook spreadsheet
 * (/codebook/view). Decides WHICH columns render and HOW WIDE, from the data
 * alone, so the layout is deterministic and testable apart from React.
 *
 * Policy:
 *  - `code`, `definition` and `notes` always render (`code`/`definition`
 *    because a codebook without them isn't one; `notes` because the printed
 *    sheet doubles as a mid-coding scratch surface — a blank Notes column is
 *    there to be written IN, on paper); every other column is DROPPED when no
 *    code has content for it — an empty "Counter-example" column is pure
 *    width tax.
 *  - Include-/exclude-if are NOT sheet columns: the printed lookup table
 *    trades them for a usable Notes margin (they remain in the editor, the
 *    coding popup and the LaTeX export).
 *  - Remaining width splits proportional to sqrt(headerLen + mean content
 *    length). sqrt dampens outliers: one code with a paragraph-long counter-
 *    example widens its column a little, not catastrophically.
 *  - Bounds [7%, 34%] hold STRICTLY: widths are clamp(t·weight, lo, hi) with t
 *    bisected until the sum is 100 (box-constrained projection). A naive
 *    clamp-then-renormalize re-inflates the capped column right back past the
 *    ceiling whenever few columns are visible — the exact case the ceiling
 *    exists for. When bounds are infeasible for the column count (e.g. two
 *    columns can't both stay ≤34% of 100%), they relax to the even share,
 *    never beyond — which keeps 100 always reachable: n·lo ≤ 100 ≤ n·hi.
 */

export type SheetColKey =
  | 'code'
  | 'definition'
  | 'exemplars'
  | 'counter'
  | 'notes'
  | 'meta';

export const SHEET_COL_HEADERS: Record<SheetColKey, string> = {
  code: 'Code',
  definition: 'Definition',
  exemplars: 'Exemplars',
  counter: 'Counter-example',
  notes: 'Notes',
  meta: 'Answers · Sources',
};

export const SHEET_COL_ORDER: SheetColKey[] = [
  'code',
  'definition',
  'exemplars',
  'counter',
  'notes',
  'meta',
];

const MIN_PCT = 7;
const MAX_PCT = 34;

export function computeSheetColumns(
  rows: Record<SheetColKey, string>[],
): { key: SheetColKey; width: number }[] {
  const visible = SHEET_COL_ORDER.filter(
    (k) =>
      k === 'code' ||
      k === 'definition' ||
      k === 'notes' || // always present — the printed sheet's write-in margin
      rows.some((r) => r[k].trim() !== ''),
  );
  const weights = visible.map((k) => {
    const mean =
      rows.length === 0 ? 0 : rows.reduce((s, r) => s + r[k].length, 0) / rows.length;
    return Math.sqrt(SHEET_COL_HEADERS[k].length + mean);
  });
  // NOTES is a WRITE-IN margin: its width is fixed to the definition column's,
  // not to its (usually empty) content — an empty margin sized by content would
  // collapse to the floor, defeating its purpose on paper.
  const defIdx = visible.indexOf('definition');
  const notesIdx = visible.indexOf('notes');
  if (defIdx >= 0 && notesIdx >= 0) weights[notesIdx] = weights[defIdx];

  const n = visible.length;
  // Feasibility: n columns must be able to sum to 100 inside [lo, hi].
  const hi = Math.max(MAX_PCT, 100 / n);
  const lo = Math.min(MIN_PCT, 100 / n);

  // sum(clamp(t·w, lo, hi)) is continuous and nondecreasing in t, spanning
  // [n·lo, n·hi] ∋ 100 — so bisection finds the exact split. 60 halvings of
  // the bracket is far past float precision.
  const clampT = (t: number) => weights.map((w) => Math.min(hi, Math.max(lo, t * w)));
  let tLo = 0;
  let tHi = hi / Math.min(...weights); // every column at its ceiling → sum ≥ 100
  for (let iter = 0; iter < 60; iter++) {
    const t = (tLo + tHi) / 2;
    const s = clampT(t).reduce((a, b) => a + b, 0);
    if (s < 100) tLo = t;
    else tHi = t;
  }
  const width = clampT(tHi);
  return visible.map((k, i) => ({ key: k, width: width[i] }));
}

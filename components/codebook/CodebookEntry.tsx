'use client';

import { memo, useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createCodesBulkWithFacets } from '@/app/actions/codes';
import { createFacetValue } from '@/app/actions/facets';
import type { CodeOrigin } from '@/app/actions/codes';
import type { FacetWithValues } from '@/app/actions/codebook';
import { facetRenderMode, coerceFacetType } from '@/lib/codebook/facet-types';
import type { CodebookRow } from '@/lib/codebook/mnemonic';
import {
  emptyRow,
  bufferedRowCount,
  lastFilledIndex,
  rowToFacetWrites,
  assembleLabelWrites,
  isGridRowEmpty,
  arrowTargetCell,
  CORE_COL_COUNT,
  INITIAL_ROWS,
  type ArrowKey,
  type FacetColumn,
  type RowData,
  type FacetCell,
} from '@/lib/codebook/grid';
import { buildLabelTree, type LabelNode } from '@/lib/codebook/labelTree';
import type { Tables } from '@/lib/types/cb-db';

type Citation = Tables<'cb_citations'>;
type FacetValue = Tables<'cb_facet_values'>;
type Label = Tables<'cb_labels'>;

// Fallback swatch color for a label with no color set (so the dot always reads;
// matches LabelTagger / LabelManager).
const DEFAULT_LABEL_SWATCH = '#000000';

/** A label flattened from the nested tree for the indented picker: the label plus
 *  its tree DEPTH, so a chip can be inset to read the nesting (Finder-style). */
type FlatLabel = { label: Label; depth: number };

/**
 * Pre-order (depth-first) flatten of the label forest into picker rows, each
 * carrying its `depth` for indentation. A parent is emitted immediately before
 * its children — the same order LabelManager renders — so the per-row multi-
 * select reads the nesting visually. PURE; built once from `buildLabelTree`.
 */
function flattenLabelTree(nodes: LabelNode[], depth = 0, out: FlatLabel[] = []): FlatLabel[] {
  for (const node of nodes) {
    out.push({ label: node, depth });
    flattenLabelTree(node.children, depth + 1, out);
  }
  return out;
}

/** Session-mode options. The chosen origin applies to EVERY code in the batch. */
const ORIGINS: { value: CodeOrigin; label: string }[] = [
  { value: 'a_priori', label: 'a priori' },
  { value: 'pilot', label: 'pilot' },
  { value: 'emergent', label: 'emergent' },
];

const OTHER = '__other__';

function citationLabel(c: Citation): string {
  if (c.bibtex_key && c.title) return `${c.bibtex_key} — ${c.title}`;
  return c.bibtex_key ?? c.title ?? c.id;
}

/**
 * Codebook bulk-entry surface (client). A scheme-derived, spreadsheet-fast grid
 * for adding many codes at once.
 *
 *  - COLUMNS ARE THE SCHEME. Two core columns (Slug* / Definition) then one column
 *    per facet, rendered by the facet's TYPE (`facetRenderMode`):
 *    enum-single → <select> of values + "Other…" (inline-add via createFacetValue);
 *    enum-multi → a checkbox menu; boolean → tri-state yes/no/unset; open_text →
 *    a text input. The grid scrolls horizontally when the scheme is wide.
 *  - A session HEADER sets the mode (origin) applied to every code, and an
 *    optional citation that links every created code `derived_from` that paper.
 *  - ~500 READY ROWS that AUTO-EXTEND: a comfortable empty tail is always kept
 *    below the last filled row, so the researcher never clicks "add row."
 *  - KEYBOARD: Enter in any cell → focus the Slug cell of the NEXT row (commit);
 *    Shift+Enter in a text cell → insert a newline (multi-line definitions).
 *  - "Create N codes" bulk-creates every named row via `createCodesBulkWithFacets`
 *    (code + version + citation + facet writes). On success committed rows clear
 *    (mode + citation + the empty buffer persist); on partial failure the failed
 *    rows stay with an inline error.
 *
 * PERFORMANCE. A naïve 500×N controlled grid re-renders every cell on each
 * keystroke and janks. Here the source of truth is a `useRef<RowData[]>`; cell
 * edits mutate that ref through stable callbacks and keep their value in LOCAL,
 * per-row state, so a keystroke re-renders only its own `GridRowView` (memoized).
 * Parent state changes (and thus full-grid re-renders) happen ONLY on structural
 * events: auto-extend (append buffer rows) and submit (reset the grid). Focus is
 * managed via a ref map of Name inputs.
 */
export default function CodebookEntry({
  codebookId,
  facets,
  citations,
  labels,
}: {
  codebookId: string;
  facets: FacetWithValues[];
  citations: Citation[];
  labels: Label[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // The codebook's LABEL vocabulary, flattened from its nesting into an indented
  // picker (built once): the Labels column's per-row multi-select renders these so
  // sub-labels read under their parents. A codebook with no labels hides the
  // column entirely (nothing to tag), mirroring how empty facet sets add no column.
  const labelPicker = useMemo(() => flattenLabelTree(buildLabelTree(labels)), [labels]);
  const hasLabels = labelPicker.length > 0;

  // Facet COLUMNS derived from the scheme (the heart of "columns = the scheme").
  // We keep both the pure `FacetColumn` (for row→write mapping + render mode) and
  // the live values list per facet (so enum cells can render labels and the
  // inline "Other…" add path can splice in a new value without a full reload).
  const [facetValues, setFacetValues] = useState<Map<string, FacetValue[]>>(
    () => new Map(facets.map((f) => [f.id, f.values])),
  );
  const columns: FacetColumn[] = useMemo(
    () =>
      facets.map((f) => ({
        facetId: f.id,
        label: f.label,
        mode: facetRenderMode(
          coerceFacetType(f.type),
          f.cardinality === 'multi' ? 'multi' : 'single',
        ),
        valueIds: (facetValues.get(f.id) ?? f.values).map((v) => v.id),
      })),
    [facets, facetValues],
  );

  // A single shared empty seed (per column shape) for the render-time `initial` of
  // every buffer row — a stable identity, so unfilled rows don't re-seed/allocate.
  const emptySeed = useMemo(() => emptyRow(columns), [columns]);

  const [origin, setOrigin] = useState<CodeOrigin>('emergent');
  const [citationId, setCitationId] = useState<string>('');
  const [result, setResult] = useState<string | null>(null);
  // Per-row error messages from the last batch, keyed by the row's CURRENT index.
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  // Source of truth for row data: a ref, so cell edits don't re-render the grid.
  const rowsRef = useRef<RowData[]>(makeRows(INITIAL_ROWS, columns));
  // `rowCount` drives the render map; it only changes on auto-extend / reset.
  const [rowCount, setRowCount] = useState(INITIAL_ROWS);

  // Render-safe SEED source for each row's initial cell data. The ref is the live
  // per-keystroke store, but the React 19 lint forbids reading `ref.current`
  // during render (it can desync the UI), so `GridRowView` cannot read the ref to
  // get its `initial`. Almost every row is an empty buffer row, so we keep ONLY
  // the non-empty seeds in state (a sparse Map keyed by row index); a missing key
  // means "seed from an empty row". This state changes ONLY on structural events
  // (initial = empty, auto-extend appends empties, submit reset / partial keep) —
  // never on a keystroke — so it does not re-render the grid as the user types.
  const [seedRows, setSeedRows] = useState<Map<number, RowData>>(() => new Map());

  // Live count of non-empty rows, for the button label. Maintained by the
  // mutation callbacks so we never scan the ref during render (lint) and never
  // re-render the grid per keystroke: it bumps ONLY when a row flips empty↔filled.
  // `filledFlags` shadows, per index, whether that row currently counts as filled.
  const [filledCount, setFilledCount] = useState(0);
  const filledFlags = useRef<boolean[]>(new Array(INITIAL_ROWS).fill(false));

  // Slug-cell refs by index, for Enter-to-next-row focus.
  const nameRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());
  const setNameRef = useCallback(
    (index: number) => (el: HTMLTextAreaElement | null) => {
      if (el) nameRefs.current.set(index, el);
      else nameRefs.current.delete(index);
    },
    [],
  );

  // ---- Arrow-key cell navigation -----------------------------------------
  // Registry of the FOCUSABLE element for every (row, col) cell, keyed
  // "row:col". Each cell registers its primary focusable element (the Slug /
  // Definition textarea, the open-text textarea, the enum <select>,
  // or the first button of a boolean / chips cell). The keydown handler resolves
  // the arrow TARGET via the pure `arrowTargetCell`, then focuses that cell's
  // element here — navigation never re-renders the grid (it only moves focus and,
  // on Down past the end, extends like Enter does).
  // The Labels column (when present) is appended AFTER the facet columns, so its
  // cell address is the last column index. `totalCols` includes it for arrow-nav
  // bounds; `labelColIndex` is -1 when the codebook has no labels (no column).
  const labelColIndex = hasLabels ? CORE_COL_COUNT + columns.length : -1;
  const totalCols = CORE_COL_COUNT + columns.length + (hasLabels ? 1 : 0);
  const cellRefs = useRef<Map<string, HTMLElement>>(new Map());
  const setCellRef = useCallback(
    (row: number, col: number) => (el: HTMLElement | null) => {
      const k = `${row}:${col}`;
      if (el) cellRefs.current.set(k, el);
      else cellRefs.current.delete(k);
    },
    [],
  );

  /** Is the column at `col` a free-text cell (so Left/Right gate on the caret)?
   *  Core columns (Slug/Definition) and open-text facets are text. */
  const isTextCol = useCallback(
    (col: number) => {
      if (col < CORE_COL_COUNT) return true;
      return columns[col - CORE_COL_COUNT]?.mode === 'open-text';
    },
    [columns],
  );

  const boundCitation = useMemo(
    () => citations.find((c) => c.id === citationId) ?? null,
    [citations, citationId],
  );

  /** Recompute the auto-extend target and grow the grid if the buffer shrank.
   *  Called after a cell mutation that could have filled a near-tail row. Cheap:
   *  one backward scan + a compare; only bumps state (full re-render) on growth. */
  const ensureBuffer = useCallback(() => {
    const target = bufferedRowCount(lastFilledIndex(rowsRef.current));
    if (target > rowsRef.current.length) {
      for (let i = rowsRef.current.length; i < target; i += 1) {
        rowsRef.current.push(emptyRow(columns));
      }
      setRowCount(target);
    }
  }, [columns]);

  /** After a cell mutation, reconcile the live `filledCount` for `index`: if the
   *  row's empty/filled status FLIPPED, bump the count (a rare event — once when a
   *  row first gets content, once if fully cleared). No-op on every other
   *  keystroke, so the parent does not re-render as the researcher types. */
  const reconcileFilled = useCallback((index: number) => {
    const row = rowsRef.current[index];
    const nowFilled = row ? !isGridRowEmpty(row) : false;
    const wasFilled = filledFlags.current[index] ?? false;
    if (nowFilled === wasFilled) return;
    filledFlags.current[index] = nowFilled;
    setFilledCount((c) => c + (nowFilled ? 1 : -1));
  }, []);

  /** Stable per-cell write-through: mutate the ref in place (no parent re-render),
   *  then keep the buffer comfortable + the filled count live. The row owns its
   *  own visible UI state, so this triggers a parent render ONLY on a structural
   *  change (auto-extend) or an empty↔filled flip. */
  const writeCore = useCallback(
    (index: number, patch: Partial<CodebookRow>) => {
      const row = rowsRef.current[index];
      if (!row) return;
      row.core = { ...row.core, ...patch };
      reconcileFilled(index);
      ensureBuffer();
    },
    [ensureBuffer, reconcileFilled],
  );

  const writeFacet = useCallback(
    (index: number, facetId: string, cell: FacetCell) => {
      const row = rowsRef.current[index];
      if (!row) return;
      row.facets = { ...row.facets, [facetId]: cell };
      reconcileFilled(index);
      ensureBuffer();
    },
    [ensureBuffer, reconcileFilled],
  );

  /** Write-through for the row's LABEL set (the full id list after a toggle),
   *  mirroring `writeFacet`: mutate the ref in place, then keep the filled count
   *  + buffer live. A label-only row counts as filled (so its tags are not lost). */
  const writeLabels = useCallback(
    (index: number, labelIds: string[]) => {
      const row = rowsRef.current[index];
      if (!row) return;
      row.labels = labelIds;
      reconcileFilled(index);
      ensureBuffer();
    },
    [ensureBuffer, reconcileFilled],
  );

  /** Grow `rowsRef`/`rowCount` so row `index` exists (mirrors the Enter extend
   *  math). No-op if the row already exists. */
  const ensureRow = useCallback(
    (index: number) => {
      if (index < rowsRef.current.length) return;
      const target = Math.max(index + 1, bufferedRowCount(index));
      for (let i = rowsRef.current.length; i < target; i += 1) {
        rowsRef.current.push(emptyRow(columns));
      }
      setRowCount(target);
    },
    [columns],
  );

  /** Focus the Name cell of `index`, extending the grid first if needed. */
  const focusName = useCallback(
    (index: number) => {
      ensureRow(index);
      // Focus after the (possible) render commit.
      queueMicrotask(() => nameRefs.current.get(index)?.focus());
    },
    [ensureRow],
  );

  /** Focus the element of cell (row, col), extending the grid first if the row is
   *  past the current end (ArrowDown auto-extend, like Enter). For text targets,
   *  drop the caret at the END so vertical/right navigation feels continuous and
   *  a subsequent ArrowRight can leave the cell immediately (matches the focus
   *  model documented on the keydown handler). */
  const focusCell = useCallback(
    (row: number, col: number) => {
      ensureRow(row);
      queueMicrotask(() => {
        const el = cellRefs.current.get(`${row}:${col}`);
        if (!el) return;
        el.focus();
        if (
          (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) &&
          typeof el.value === 'string'
        ) {
          const end = el.value.length;
          try {
            el.setSelectionRange(end, end);
          } catch {
            // Some input types disallow setSelectionRange; focus alone is fine.
          }
        }
      });
    },
    [ensureRow],
  );

  /** Shared arrow-key handler for every cell. Resolves the target cell from the
   *  PURE `arrowTargetCell` (using the live caret state for text cells) and moves
   *  focus there. Returns true iff it handled the key (so the caller can
   *  `preventDefault`). For a native <select>, Up/Down are NOT intercepted (they
   *  change the open option natively) — only Left/Right navigate; this is the
   *  non-trapping choice for selects (you leave via Left/Right/Enter/Tab). */
  const handleArrowNav = useCallback(
    (
      e: React.KeyboardEvent<HTMLElement>,
      row: number,
      col: number,
      opts: { isText: boolean; isSelect?: boolean },
    ): boolean => {
      const key = e.key;
      if (
        key !== 'ArrowUp' &&
        key !== 'ArrowDown' &&
        key !== 'ArrowLeft' &&
        key !== 'ArrowRight'
      ) {
        return false;
      }
      // Native <select>: let Up/Down change the option (don't trap the user);
      // only Left/Right move cells.
      if (opts.isSelect && (key === 'ArrowUp' || key === 'ArrowDown')) return false;

      let caretAtStart = false;
      let caretAtEnd = false;
      if (opts.isText) {
        const t = e.target as HTMLTextAreaElement | HTMLInputElement;
        const len = t.value?.length ?? 0;
        const noSelection = t.selectionStart === t.selectionEnd;
        caretAtStart = noSelection && t.selectionStart === 0;
        caretAtEnd = noSelection && t.selectionEnd === len;
      }

      const target = arrowTargetCell({
        row,
        col,
        key: key as ArrowKey,
        isTextCell: opts.isText,
        caretAtStart,
        caretAtEnd,
        colCount: totalCols,
        rowCount: rowsRef.current.length,
      });
      if (!target) return false;

      e.preventDefault();
      focusCell(target.row, target.col);
      return true;
    },
    [focusCell, totalCols],
  );

  function chooseCitation(id: string) {
    setCitationId(id);
    if (id) setOrigin('a_priori');
  }

  /** Inline "Other…": create a value on a facet, splice it into the live values
   *  list so every row's dropdown sees it, and return the new id for assignment. */
  const addFacetValue = useCallback(
    async (facetId: string, label: string): Promise<FacetValue | null> => {
      const trimmed = label.trim();
      if (!trimmed) return null;
      const { slugifyValueKey } = await import('@/lib/codebook/facet-types');
      const value = await createFacetValue(facetId, {
        key: slugifyValueKey(trimmed),
        label: trimmed,
      });
      setFacetValues((prev) => {
        const next = new Map(prev);
        next.set(facetId, [...(next.get(facetId) ?? []), value]);
        return next;
      });
      return value;
    },
    [],
  );

  // The named/used row count for the button label is the live `filledCount`
  // state, maintained by `reconcileFilled` on empty↔filled flips. (We do NOT scan
  // `rowsRef` here: reading a ref during render is forbidden by the React 19 lint
  // and would also re-run the scan on every render.)
  const nonEmptyCount = filledCount;

  function submit() {
    // Snapshot the non-empty rows with their CURRENT indices.
    const submitted: { index: number; row: RowData }[] = [];
    rowsRef.current.forEach((row, index) => {
      if (!isGridRowEmpty(row)) submitted.push({ index, row });
    });
    if (submitted.length === 0) {
      setResult('Nothing to create — add at least one name.');
      return;
    }
    setResult(null);
    setRowErrors({});

    // Build the parallel core-rows array + facet-writes map keyed by the SUBMIT
    // index (0-based position in `coreRows`), matching how `resolveRows` reports
    // errors (by index into the array it was handed).
    const coreRows: CodebookRow[] = submitted.map((s) => s.row.core);
    const facetWritesByIndex: Record<number, ReturnType<typeof rowToFacetWrites>> = {};
    submitted.forEach((s, submitIdx) => {
      facetWritesByIndex[submitIdx] = rowToFacetWrites(s.row, columns);
    });
    // Label writes keyed by the SAME submit index the facet writes use (position
    // in `coreRows`), matching how `resolveRows` reports `row.index`. Rows with no
    // labels are omitted by `assembleLabelWrites` → no `setCodeLabels` call.
    const labelWritesByIndex = assembleLabelWrites(
      submitted.map((s, submitIdx) => ({ index: submitIdx, row: s.row })),
    );

    startTransition(async () => {
      try {
        const res = await createCodesBulkWithFacets(
          codebookId,
          coreRows,
          facetWritesByIndex,
          origin,
          citationId || undefined,
          labelWritesByIndex,
        );

        if (res.errors.length === 0) {
          // Full success: reset the grid (mode + citation persist) and re-read so
          // the Scheme/matrix reflects the new codes.
          rowsRef.current = makeRows(INITIAL_ROWS, columns);
          nameRefs.current.clear();
          cellRefs.current.clear();
          filledFlags.current = new Array(INITIAL_ROWS).fill(false);
          setSeedRows(new Map());
          setFilledCount(0);
          setRowCount(INITIAL_ROWS);
          setRowErrors({});
          setResult(`Created ${res.created} code${res.created === 1 ? '' : 's'}.`);
          router.refresh();
          return;
        }

        // Partial failure: rebuild the grid keeping ONLY the failed rows (mapped
        // by their submit index back to the original RowData), then the buffer.
        const failedSubmitIdx = new Set(res.errors.map((e) => e.index));
        const kept: RowData[] = [];
        const errsByIndex: Record<number, string> = {};
        submitted.forEach((s, submitIdx) => {
          if (failedSubmitIdx.has(submitIdx)) {
            const keptIndex = kept.length;
            kept.push(s.row);
            const msg = res.errors.find((e) => e.index === submitIdx)?.message;
            if (msg) errsByIndex[keptIndex] = msg;
          }
        });
        const keptFilled = kept.length; // every kept row is non-empty by construction
        const target = bufferedRowCount(kept.length - 1);
        for (let i = kept.length; i < target; i += 1) kept.push(emptyRow(columns));
        rowsRef.current = kept;
        nameRefs.current.clear();
        cellRefs.current.clear();
        // Render-safe seeds for the kept (failed) rows, so their cells repopulate
        // after the remount without reading the ref during render. Buffer rows
        // (>= keptFilled) seed empty (absent from the map). Rebuild the filled
        // flags + count to match (the kept rows are the only filled ones now).
        const seeds = new Map<number, RowData>();
        const flags = new Array(target).fill(false);
        for (let i = 0; i < keptFilled; i += 1) {
          seeds.set(i, kept[i]);
          flags[i] = true;
        }
        filledFlags.current = flags;
        setSeedRows(seeds);
        setFilledCount(keptFilled);
        setRowCount(target);
        setRowErrors(errsByIndex);
        setResult(
          `Created ${res.created} code${res.created === 1 ? '' : 's'}; ${res.errors.length} row${
            res.errors.length === 1 ? '' : 's'
          } failed (kept below).`,
        );
        if (res.created > 0) router.refresh();
      } catch (err) {
        setResult(err instanceof Error ? err.message : 'Bulk create failed.');
      }
    });
  }

  // A version key forces row remounts after a structural reset (success/partial)
  // so each row re-seeds its local state from the (new) ref. It changes only on
  // those resets, never on cell edits.
  const [gridVersion, setGridVersion] = useState(0);
  const resetVersion = useCallback(() => setGridVersion((v) => v + 1), []);
  // Bump the version whenever the row identity array is replaced wholesale.
  const submitWithReset = useCallback(() => {
    const before = rowsRef.current;
    submit();
    // If submit replaced the array (success or partial), force a remount.
    queueMicrotask(() => {
      if (rowsRef.current !== before) resetVersion();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, citationId, columns, codebookId]);

  return (
    <main className="px-6 py-6 space-y-6">
      <header>
        <h1 className="text-xl font-medium tracking-tight">Codebook</h1>
        <p className="mt-1 text-xs text-foreground/50">
          <kbd className="font-mono">Enter</kbd> next row · <kbd className="font-mono">Shift+Enter</kbd>{' '}
          new line · only <span className="font-medium text-foreground/70">slug</span> is required
        </p>
      </header>

      {/* Session header: mode + optional citation (apply to the whole batch). */}
      <section className="flex flex-wrap items-end gap-4 border border-foreground/15 px-4 py-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-foreground/50">mode</span>
          <select
            value={origin}
            onChange={(e) => setOrigin(e.target.value as CodeOrigin)}
            className="border border-foreground/20 bg-background px-2 py-1.5 text-sm"
            aria-label="Session mode (code origin)"
          >
            {ORIGINS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-foreground/50">
            citation <span className="normal-case text-foreground/30">(optional · derived from)</span>
          </span>
          {citations.length === 0 ? (
            <span className="px-2 py-1.5 text-sm text-foreground/50">
              No citations —{' '}
              <Link href="/citations" className="underline underline-offset-2">
                add them
              </Link>
              .
            </span>
          ) : (
            <select
              value={citationId}
              onChange={(e) => chooseCitation(e.target.value)}
              className="min-w-64 border border-foreground/20 bg-background px-2 py-1.5 text-sm"
              aria-label="Bind a citation to every code this session"
            >
              <option value="">— none —</option>
              {citations.map((c) => (
                <option key={c.id} value={c.id}>
                  {citationLabel(c)}
                </option>
              ))}
            </select>
          )}
        </label>

        {boundCitation && (
          <p className="text-xs text-foreground/60">
            Every code links{' '}
            <span className="font-medium text-foreground/80">derived from</span>{' '}
            <span className="font-mono text-foreground/70">
              {boundCitation.bibtex_key ?? boundCitation.title ?? boundCitation.id}
            </span>
            .
          </p>
        )}
      </section>

      {/* Scheme-derived spreadsheet grid. Horizontal scroll when wide. */}
      <section>
        <div className="overflow-x-auto border border-foreground/15">
          <table className="w-full border-collapse text-sm" style={{ minWidth: tableMinWidth(columns, hasLabels) }}>
            <thead>
              <tr className="border-b border-foreground/15 text-left">
                <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-foreground/50" style={{ width: 220 }}>
                  Slug<span className="text-red-600">*</span>
                </th>
                <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-foreground/50" style={{ width: 260 }}>
                  Definition
                </th>
                {columns.map((col) => (
                  <th
                    key={col.facetId}
                    className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-foreground/50"
                    style={{ width: facetColWidth(col.mode) }}
                  >
                    {col.label}
                  </th>
                ))}
                {hasLabels && (
                  <th
                    className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-foreground/50"
                    style={{ width: LABEL_COL_WIDTH }}
                  >
                    Labels
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rowCount }, (_, index) => (
                <GridRowView
                  key={`${gridVersion}-${index}`}
                  index={index}
                  initial={seedRows.get(index) ?? emptySeed}
                  columns={columns}
                  facetValues={facetValues}
                  labelPicker={labelPicker}
                  labelColIndex={labelColIndex}
                  error={rowErrors[index]}
                  disabled={isPending}
                  setNameRef={setNameRef}
                  setCellRef={setCellRef}
                  handleArrowNav={handleArrowNav}
                  isTextCol={isTextCol}
                  writeCore={writeCore}
                  writeFacet={writeFacet}
                  writeLabels={writeLabels}
                  focusName={focusName}
                  addFacetValue={addFacetValue}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={submitWithReset}
            disabled={isPending || nonEmptyCount === 0}
            className="border border-foreground px-3 py-1.5 text-sm transition hover:bg-foreground hover:text-background disabled:opacity-40"
          >
            {isPending
              ? 'Creating…'
              : `Create ${nonEmptyCount} code${nonEmptyCount === 1 ? '' : 's'}`}
          </button>
          {result && <span className="text-sm text-foreground/70">{result}</span>}
        </div>
      </section>
    </main>
  );
}

/** Build `n` empty rows for the given columns (fresh cell bags per row). */
function makeRows(n: number, columns: FacetColumn[]): RowData[] {
  const rows: RowData[] = [];
  for (let i = 0; i < n; i += 1) rows.push(emptyRow(columns));
  return rows;
}

/** Per-mode column width (px) for layout stability + a sensible min table width. */
function facetColWidth(mode: FacetColumn['mode']): number {
  switch (mode) {
    case 'enum-multi':
      return 220;
    case 'open-text':
      return 220;
    case 'boolean':
      return 150;
    case 'enum-single':
    default:
      return 180;
  }
}

/** Column width (px) for the Labels multi-select (a chip menu like enum-multi). */
const LABEL_COL_WIDTH = 240;

function tableMinWidth(columns: FacetColumn[], hasLabels: boolean): number {
  return (
    220 +
    260 +
    columns.reduce((sum, c) => sum + facetColWidth(c.mode), 0) +
    (hasLabels ? LABEL_COL_WIDTH : 0)
  );
}

// ---------------------------------------------------------------------------
// Per-row view — memoized + locally-stateful so a keystroke re-renders ONE row.
// ---------------------------------------------------------------------------

/** Arrow-nav callback shared by every cell: (event, row, col, opts) → handled? */
type ArrowNavHandler = (
  e: React.KeyboardEvent<HTMLElement>,
  row: number,
  col: number,
  opts: { isText: boolean; isSelect?: boolean },
) => boolean;

type GridRowProps = {
  index: number;
  initial: RowData;
  columns: FacetColumn[];
  facetValues: Map<string, FacetValue[]>;
  /** The codebook's labels flattened (with depth) for the indented picker. */
  labelPicker: FlatLabel[];
  /** Cell column index of the Labels column, or -1 when there are no labels. */
  labelColIndex: number;
  error?: string;
  disabled: boolean;
  setNameRef: (index: number) => (el: HTMLTextAreaElement | null) => void;
  setCellRef: (row: number, col: number) => (el: HTMLElement | null) => void;
  handleArrowNav: ArrowNavHandler;
  isTextCol: (col: number) => boolean;
  writeCore: (index: number, patch: Partial<CodebookRow>) => void;
  writeFacet: (index: number, facetId: string, cell: FacetCell) => void;
  writeLabels: (index: number, labelIds: string[]) => void;
  focusName: (index: number) => void;
  addFacetValue: (facetId: string, label: string) => Promise<FacetValue | null>;
};

const GridRowView = memo(function GridRowView({
  index,
  initial,
  columns,
  facetValues,
  labelPicker,
  labelColIndex,
  error,
  disabled,
  setNameRef,
  setCellRef,
  handleArrowNav,
  isTextCol,
  writeCore,
  writeFacet,
  writeLabels,
  focusName,
  addFacetValue,
}: GridRowProps) {
  // Local mirror of this row's data; the parent ref is the durable source.
  const [slug, setSlug] = useState(initial.core.slug);
  const [definition, setDefinition] = useState(initial.core.definition);
  const [facetState, setFacetState] = useState<Record<string, FacetCell>>(initial.facets);
  const [labelState, setLabelState] = useState<string[]>(initial.labels);

  function commitSlug(v: string) {
    setSlug(v);
    writeCore(index, { slug: v });
  }
  function commitDefinition(v: string) {
    setDefinition(v);
    writeCore(index, { definition: v });
  }
  function commitFacet(facetId: string, cell: FacetCell) {
    setFacetState((prev) => ({ ...prev, [facetId]: cell }));
    writeFacet(index, facetId, cell);
  }
  /** Toggle one label id in this row's set, recompute the full set, write through. */
  function commitLabelToggle(labelId: string) {
    setLabelState((prev) => {
      const next = prev.includes(labelId)
        ? prev.filter((id) => id !== labelId)
        : [...prev, labelId];
      writeLabels(index, next);
      return next;
    });
  }

  /** The Slug cell registers with BOTH the name-ref map (Enter focus) and the
   *  generic cell-ref registry (arrow nav at col 0). */
  const nameCellRef = (el: HTMLTextAreaElement | null) => {
    setNameRef(index)(el);
    setCellRef(index, 0)(el);
  };

  /** Keydown for a CORE text cell at `col`: Enter→next Slug, Shift+Enter→newline,
   *  arrows→cell nav (caret-aware via the parent handler). */
  function onCoreTextKeyDown(col: number) {
    return (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        focusName(index + 1);
        return;
      }
      // Shift+Enter: let the textarea insert a newline (default behavior).
      handleArrowNav(e, index, col, { isText: true });
    };
  }

  return (
    <tr className={`border-b border-foreground/10 ${error ? 'bg-red-500/5' : ''}`}>
      <td className="align-top">
        <textarea
          ref={nameCellRef}
          value={slug}
          rows={1}
          disabled={disabled}
          onChange={(e) => commitSlug(e.target.value)}
          onKeyDown={onCoreTextKeyDown(0)}
          placeholder="code slug"
          aria-label="Code slug"
          className="w-full resize-none bg-transparent px-3 py-1.5 font-mono text-xs outline-none focus:bg-foreground/5 disabled:opacity-50"
        />
        {error && <div className="px-3 pb-1 text-xs text-red-600">{error}</div>}
      </td>
      <td className="align-top">
        <textarea
          ref={setCellRef(index, 1)}
          value={definition}
          rows={1}
          disabled={disabled}
          onChange={(e) => commitDefinition(e.target.value)}
          onKeyDown={onCoreTextKeyDown(1)}
          placeholder="one-line definition (optional)"
          aria-label="Code definition (optional)"
          className="w-full resize-none bg-transparent px-3 py-1.5 outline-none focus:bg-foreground/5 disabled:opacity-50"
        />
      </td>
      {columns.map((col, ci) => {
        const colIndex = CORE_COL_COUNT + ci;
        return (
          <td key={col.facetId} className="align-top px-2 py-1">
            <FacetCellInput
              col={col}
              values={facetValues.get(col.facetId) ?? []}
              cell={facetState[col.facetId] ?? { kind: 'enum', valueIds: [] }}
              disabled={disabled}
              registerRef={setCellRef(index, colIndex)}
              onArrowKeyDown={(e) =>
                handleArrowNav(e, index, colIndex, {
                  isText: isTextCol(colIndex),
                  isSelect: col.mode === 'enum-single',
                })
              }
              onChange={(cell) => commitFacet(col.facetId, cell)}
              onAddValue={(label) => addFacetValue(col.facetId, label)}
              onEnter={() => focusName(index + 1)}
            />
          </td>
        );
      })}
      {labelColIndex >= 0 && (
        <td className="align-top px-2 py-1">
          <LabelMultiCell
            picker={labelPicker}
            selected={labelState}
            disabled={disabled}
            registerRef={setCellRef(index, labelColIndex)}
            onArrowKeyDown={(e) =>
              handleArrowNav(e, index, labelColIndex, { isText: isTextCol(labelColIndex) })
            }
            onToggle={commitLabelToggle}
          />
        </td>
      )}
    </tr>
  );
});

// ---------------------------------------------------------------------------
// Facet cell inputs, one per render mode.
// ---------------------------------------------------------------------------

function FacetCellInput({
  col,
  values,
  cell,
  disabled,
  registerRef,
  onArrowKeyDown,
  onChange,
  onAddValue,
  onEnter,
}: {
  col: FacetColumn;
  values: FacetValue[];
  cell: FacetCell;
  disabled: boolean;
  /** Register THIS cell's primary focusable element for arrow-nav focus. */
  registerRef: (el: HTMLElement | null) => void;
  /** Arrow-key handler (caret-aware) shared across cell types. */
  onArrowKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onChange: (cell: FacetCell) => void;
  onAddValue: (label: string) => Promise<FacetValue | null>;
  onEnter: () => void;
}) {
  switch (col.mode) {
    case 'enum-single':
      return (
        <EnumSingleCell
          values={values}
          selected={cell.kind === 'enum' ? cell.valueIds[0] ?? '' : ''}
          disabled={disabled}
          registerRef={registerRef}
          onArrowKeyDown={onArrowKeyDown}
          onPick={(valueId) => onChange({ kind: 'enum', valueIds: valueId ? [valueId] : [] })}
          onAddValue={onAddValue}
        />
      );
    case 'enum-multi':
      return (
        <EnumMultiCell
          values={values}
          selected={cell.kind === 'enum' ? cell.valueIds : []}
          disabled={disabled}
          registerRef={registerRef}
          onArrowKeyDown={onArrowKeyDown}
          onToggle={(valueId) => {
            const cur = cell.kind === 'enum' ? cell.valueIds : [];
            const next = cur.includes(valueId)
              ? cur.filter((v) => v !== valueId)
              : [...cur, valueId];
            onChange({ kind: 'enum', valueIds: next });
          }}
          onAddValue={onAddValue}
        />
      );
    case 'boolean':
      return (
        <BooleanCell
          value={cell.kind === 'boolean' ? cell.bool : null}
          disabled={disabled}
          registerRef={registerRef}
          onArrowKeyDown={onArrowKeyDown}
          onChange={(b) => onChange({ kind: 'boolean', bool: b })}
        />
      );
    case 'open-text':
    default:
      return (
        <OpenTextCell
          value={cell.kind === 'open_text' ? cell.text : ''}
          disabled={disabled}
          registerRef={registerRef}
          onArrowKeyDown={onArrowKeyDown}
          onChange={(t) => onChange({ kind: 'open_text', text: t })}
          onEnter={onEnter}
        />
      );
  }
}

/** enum-single: a <select> of values + an "Other…" option that reveals an inline
 *  text field to add a value (createFacetValue) and assign it. */
function EnumSingleCell({
  values,
  selected,
  disabled,
  registerRef,
  onArrowKeyDown,
  onPick,
  onAddValue,
}: {
  values: FacetValue[];
  selected: string;
  disabled: boolean;
  registerRef: (el: HTMLElement | null) => void;
  onArrowKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onPick: (valueId: string) => void;
  onAddValue: (label: string) => Promise<FacetValue | null>;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <select
        ref={registerRef}
        value={adding ? OTHER : selected}
        disabled={disabled || busy}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OTHER) setAdding(true);
          else {
            setAdding(false);
            onPick(v);
          }
        }}
        onKeyDown={onArrowKeyDown}
        aria-label={`${values.length} options`}
        className="w-full border border-foreground/15 bg-background px-2 py-1 text-sm disabled:opacity-50"
      >
        <option value="">—</option>
        {values.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {adding && (
        <InlineAdd
          disabled={disabled || busy}
          onSubmit={async (label) => {
            setBusy(true);
            try {
              const value = await onAddValue(label);
              if (value) onPick(value.id);
            } finally {
              setBusy(false);
              setAdding(false);
            }
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/** enum-multi: a compact checkbox menu (chips) + "Other…" inline add. */
function EnumMultiCell({
  values,
  selected,
  disabled,
  registerRef,
  onArrowKeyDown,
  onToggle,
  onAddValue,
}: {
  values: FacetValue[];
  selected: string[];
  disabled: boolean;
  registerRef: (el: HTMLElement | null) => void;
  onArrowKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onToggle: (valueId: string) => void;
  onAddValue: (label: string) => Promise<FacetValue | null>;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const sel = new Set(selected);
  // The cell's focusable target for arrow-nav is the FIRST chip; if there are no
  // value chips, the "+ Other…" button is the first focusable element instead.
  const hasChips = values.length > 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {values.length === 0 && <span className="text-xs text-foreground/30">no values</span>}
        {values.map((v, i) => {
          const on = sel.has(v.id);
          const isFirst = i === 0;
          return (
            <button
              key={v.id}
              ref={isFirst ? registerRef : undefined}
              type="button"
              disabled={disabled || busy}
              aria-pressed={on}
              onClick={() => onToggle(v.id)}
              onKeyDown={isFirst ? onArrowKeyDown : undefined}
              className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-xs transition disabled:opacity-50 ${
                on
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-foreground/20 hover:border-foreground'
              }`}
            >
              {v.color && (
                <span
                  className="inline-block h-2 w-2 rounded-sm shrink-0"
                  style={{ backgroundColor: v.color }}
                  aria-hidden
                />
              )}
              {v.label}
            </button>
          );
        })}
        {!adding && (
          <button
            ref={hasChips ? undefined : registerRef}
            type="button"
            disabled={disabled || busy}
            onClick={() => setAdding(true)}
            onKeyDown={hasChips ? undefined : onArrowKeyDown}
            className="inline-flex items-center border border-dashed border-foreground/30 px-1.5 py-0.5 text-xs hover:border-foreground transition disabled:opacity-50"
          >
            + Other…
          </button>
        )}
      </div>
      {adding && (
        <InlineAdd
          disabled={disabled || busy}
          onSubmit={async (label) => {
            setBusy(true);
            try {
              const value = await onAddValue(label);
              if (value) onToggle(value.id);
            } finally {
              setBusy(false);
              setAdding(false);
            }
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/** Labels: a compact multi-select chip menu over the codebook's NESTED label
 *  vocabulary. Modeled on `EnumMultiCell` (the enum-multi facet cell) — the same
 *  toggle-chip UX and arrow-nav focus model (first chip is the cell's focusable
 *  target) — but the chips are INDENTED by tree depth so sub-labels read under
 *  their parents, each carries the label's color dot, and there is no inline
 *  "Other…" add (the label vocabulary is curated on the Labels page, not here).
 *  Each toggle reports the single id; the row recomputes the full set + writes it. */
function LabelMultiCell({
  picker,
  selected,
  disabled,
  registerRef,
  onArrowKeyDown,
  onToggle,
}: {
  picker: FlatLabel[];
  selected: string[];
  disabled: boolean;
  registerRef: (el: HTMLElement | null) => void;
  onArrowKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onToggle: (labelId: string) => void;
}) {
  const sel = new Set(selected);
  return (
    <div className="flex flex-col gap-1">
      {picker.length === 0 && <span className="text-xs text-foreground/30">no labels</span>}
      {picker.map(({ label: lbl, depth }, i) => {
        const on = sel.has(lbl.id);
        const isFirst = i === 0;
        return (
          <button
            key={lbl.id}
            ref={isFirst ? registerRef : undefined}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onToggle(lbl.id)}
            onKeyDown={isFirst ? onArrowKeyDown : undefined}
            // Indent by depth so nesting reads at a glance (Finder-style).
            style={{ marginLeft: depth * 12 }}
            className={`inline-flex items-center gap-1 self-start border px-1.5 py-0.5 text-xs transition disabled:opacity-50 ${
              on
                ? 'border-foreground bg-foreground text-background'
                : 'border-foreground/20 hover:border-foreground'
            }`}
          >
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: lbl.color ?? DEFAULT_LABEL_SWATCH }}
              aria-hidden
            />
            {lbl.name}
          </button>
        );
      })}
    </div>
  );
}

/** boolean: tri-state yes / no / unset. */
function BooleanCell({
  value,
  disabled,
  registerRef,
  onArrowKeyDown,
  onChange,
}: {
  value: boolean | null;
  disabled: boolean;
  registerRef: (el: HTMLElement | null) => void;
  onArrowKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onChange: (b: boolean | null) => void;
}) {
  const opts: { label: string; v: boolean | null }[] = [
    { label: 'unset', v: null },
    { label: 'no', v: false },
    { label: 'yes', v: true },
  ];
  return (
    <div className="inline-flex border border-foreground/20" role="radiogroup" aria-label="yes/no">
      {opts.map((o, i) => {
        const on = value === o.v;
        const isFirst = i === 0;
        return (
          <button
            key={o.label}
            ref={isFirst ? registerRef : undefined}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.v)}
            onKeyDown={isFirst ? onArrowKeyDown : undefined}
            className={`px-1.5 py-0.5 text-xs transition disabled:opacity-50 ${
              i > 0 ? 'border-l border-foreground/20' : ''
            } ${on ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** open_text: a text input; Enter (no shift) advances to the next row's Name,
 *  Shift+Enter is left to the textarea to insert a newline, arrows navigate cells
 *  (caret-aware via the parent handler). */
function OpenTextCell({
  value,
  disabled,
  registerRef,
  onArrowKeyDown,
  onChange,
  onEnter,
}: {
  value: string;
  disabled: boolean;
  registerRef: (el: HTMLElement | null) => void;
  onArrowKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onChange: (t: string) => void;
  onEnter: () => void;
}) {
  return (
    <textarea
      ref={registerRef}
      value={value}
      rows={1}
      disabled={disabled}
      placeholder="note…"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onEnter();
          return;
        }
        onArrowKeyDown(e);
      }}
      aria-label="Open response"
      className="w-full resize-none border border-foreground/15 bg-background px-2 py-1 text-sm outline-none disabled:opacity-50"
    />
  );
}

/** Shared inline "type a new value" entry: Enter submits, Escape cancels. */
function InlineAdd({
  disabled,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  onSubmit: (label: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        value={text}
        disabled={disabled}
        placeholder="new value…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (text.trim()) onSubmit(text);
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        aria-label="New value name"
        className="w-full border border-foreground/15 bg-background px-2 py-0.5 text-xs"
      />
      <button
        type="button"
        disabled={disabled || !text.trim()}
        onClick={() => onSubmit(text)}
        className="border border-foreground/30 px-1.5 py-0.5 text-xs hover:bg-foreground hover:text-background transition disabled:opacity-50"
      >
        add
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onCancel}
        className="text-xs text-foreground/40 hover:text-foreground disabled:opacity-50"
      >
        ×
      </button>
    </span>
  );
}

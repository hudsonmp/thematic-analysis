'use client';

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createCodesBulk } from '@/app/actions/codes';
import type { CodeOrigin } from '@/app/actions/codes';
import { isRowEmpty, type CodebookRow } from '@/lib/codebook/mnemonic';
import type { Tables } from '@/lib/types/cb-db';

type Citation = Tables<'cb_citations'>;

/** Session-mode options. The chosen origin applies to EVERY code in the batch. */
const ORIGINS: { value: CodeOrigin; label: string }[] = [
  { value: 'a_priori', label: 'a priori' },
  { value: 'pilot', label: 'pilot' },
  { value: 'emergent', label: 'emergent' },
];

type Col = 'name' | 'mnemonic' | 'definition';

/** A grid row with a stable client id (for keys + focus) and its three cells. */
type GridRow = { id: string; name: string; mnemonic: string; definition: string };

function citationLabel(c: Citation): string {
  if (c.bibtex_key && c.title) return `${c.bibtex_key} — ${c.title}`;
  return c.bibtex_key ?? c.title ?? c.id;
}

function newRow(): GridRow {
  return {
    id: `r-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: '',
    mnemonic: '',
    definition: '',
  };
}

function toCodebookRow(r: GridRow): CodebookRow {
  return { name: r.name, mnemonic: r.mnemonic, definition: r.definition };
}

/**
 * Codebook bulk-entry surface (client). A spreadsheet-like grid for adding many
 * codes fast:
 *
 *  - A session HEADER sets the mode (origin) applied to every code, and an
 *    optional citation that links every created code `derived_from` that paper
 *    (same as the deductive flow, applied to a batch). Picking a citation
 *    defaults the mode to "a priori" (overridable).
 *  - The GRID has a Name* (required), Mnemonic, Definition column per row, with
 *    an always-present blank trailing row. Enter (or Tab past the last cell)
 *    commits the row and focuses a fresh one — keyboard-first entry.
 *  - "Create N codes" bulk-creates every non-empty row via `createCodesBulk`.
 *    On success the committed rows clear but the mode + citation persist for the
 *    next batch; on partial failure the failed rows stay in the grid with an
 *    inline message.
 *
 * Mutations run in a transition from handlers and `router.refresh()` after a
 * successful batch (so the Scheme/matrix re-reads) — no Server Action during
 * render. Mnemonic blanks are synthesized server-side (see `createCodesBulk`).
 */
export default function CodebookEntry({
  codebookId,
  citations,
}: {
  codebookId: string;
  citations: Citation[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [origin, setOrigin] = useState<CodeOrigin>('emergent');
  const [citationId, setCitationId] = useState<string>('');
  const [rows, setRows] = useState<GridRow[]>([newRow()]);
  const [result, setResult] = useState<string | null>(null);
  // Per-original-index error messages from the last batch, keyed to the grid row
  // by its position among the non-empty rows submitted.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // cellRefs[rowId][col] -> input element, for keyboard focus management.
  const cellRefs = useRef<Map<string, Partial<Record<Col, HTMLInputElement>>>>(new Map());

  const setCellRef = useCallback(
    (rowId: string, col: Col) => (el: HTMLInputElement | null) => {
      const map = cellRefs.current;
      const entry = map.get(rowId) ?? {};
      if (el) entry[col] = el;
      else delete entry[col];
      map.set(rowId, entry);
    },
    [],
  );

  const boundCitation = useMemo(
    () => citations.find((c) => c.id === citationId) ?? null,
    [citations, citationId],
  );

  const nonEmptyCount = useMemo(() => rows.filter((r) => !isRowEmpty(r)).length, [rows]);

  function updateCell(rowId: string, col: Col, value: string) {
    setRows((prev) => {
      const next = prev.map((r) => (r.id === rowId ? { ...r, [col]: value } : r));
      // Keep exactly one trailing blank row: if the last row is now non-empty,
      // append a fresh blank.
      const last = next[next.length - 1];
      if (last && !isRowEmpty(last)) next.push(newRow());
      return next;
    });
    setResult(null);
  }

  function chooseCitation(id: string) {
    setCitationId(id);
    // Picking a paper defaults the mode to a_priori (overridable), matching the
    // deductive flow. Clearing the paper leaves the mode as-is.
    if (id) setOrigin('a_priori');
  }

  /** Focus the Name cell of the row after `rowId` (creating it if needed). */
  function focusNextRow(rowId: string) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === rowId);
      let next = prev;
      let targetId: string;
      if (idx === prev.length - 1) {
        const fresh = newRow();
        next = [...prev, fresh];
        targetId = fresh.id;
      } else {
        targetId = prev[idx + 1].id;
      }
      // Focus after the row list commits.
      queueMicrotask(() => cellRefs.current.get(targetId)?.name?.focus());
      return next;
    });
  }

  function onCellKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
    rowId: string,
    col: Col,
  ) {
    if (e.key === 'Enter') {
      e.preventDefault();
      focusNextRow(rowId);
      return;
    }
    // Tab past the last cell of the last row commits a new row (so the trailing
    // blank is always reachable by keyboard). Shift+Tab is left to the browser.
    if (e.key === 'Tab' && !e.shiftKey && col === 'definition') {
      const isLast = rows[rows.length - 1]?.id === rowId;
      if (isLast) {
        e.preventDefault();
        focusNextRow(rowId);
      }
    }
  }

  function submit() {
    const toSubmit = rows.filter((r) => !isRowEmpty(r));
    if (toSubmit.length === 0) {
      setResult('Nothing to create — add at least one name.');
      return;
    }
    setResult(null);
    setRowErrors({});

    startTransition(async () => {
      try {
        const res = await createCodesBulk(
          codebookId,
          toSubmit.map(toCodebookRow),
          origin,
          citationId || undefined,
        );

        if (res.errors.length === 0) {
          // Full success: clear the grid (mode + citation persist for the next
          // batch) and re-read so the matrix reflects the new codes.
          setRows([newRow()]);
          setResult(`Created ${res.created} code${res.created === 1 ? '' : 's'}.`);
          router.refresh();
          return;
        }

        // Partial failure: keep ONLY the rows that failed (by their submitted
        // index) so the researcher can fix + retry; map errors onto them.
        const failedIdx = new Set(res.errors.map((e) => e.index));
        const kept: GridRow[] = [];
        const errsByRowId: Record<string, string> = {};
        toSubmit.forEach((r, i) => {
          if (failedIdx.has(i)) {
            kept.push(r);
            const msg = res.errors.find((e) => e.index === i)?.message;
            if (msg) errsByRowId[r.id] = msg;
          }
        });
        kept.push(newRow());
        setRows(kept);
        setRowErrors(errsByRowId);
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

  return (
    <main className="px-6 py-6 space-y-6">
      <header>
        <h1 className="text-xl font-medium tracking-tight">Codebook</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-foreground/60">
          Add many codes at once. Pick a <span className="font-medium text-foreground/80">mode</span>{' '}
          (and optionally bind a paper) for the whole session, then type rows —{' '}
          <kbd className="font-mono text-xs">Enter</kbd> commits a row and starts a
          new one. Only <span className="font-medium text-foreground/80">Name</span> is
          required. The full anatomy of each code stays editable on its{' '}
          <Link href="/" className="underline underline-offset-2">
            Scheme
          </Link>{' '}
          page.
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

      {/* Spreadsheet grid. */}
      <section>
        <div className="overflow-x-auto border border-foreground/15">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-foreground/15 text-left">
                <th className="w-1/4 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-foreground/50">
                  Name<span className="text-red-600">*</span>
                </th>
                <th className="w-1/5 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-foreground/50">
                  Mnemonic
                </th>
                <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-foreground/50">
                  Definition
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const err = rowErrors[r.id];
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-foreground/10 ${err ? 'bg-red-500/5' : ''}`}
                  >
                    <td className="align-top">
                      <input
                        ref={setCellRef(r.id, 'name')}
                        value={r.name}
                        onChange={(e) => updateCell(r.id, 'name', e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r.id, 'name')}
                        placeholder="code name"
                        aria-label="Code name"
                        className="w-full bg-transparent px-3 py-1.5 outline-none focus:bg-foreground/5"
                      />
                      {err && <div className="px-3 pb-1 text-xs text-red-600">{err}</div>}
                    </td>
                    <td className="align-top">
                      <input
                        ref={setCellRef(r.id, 'mnemonic')}
                        value={r.mnemonic}
                        onChange={(e) => updateCell(r.id, 'mnemonic', e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r.id, 'mnemonic')}
                        placeholder="(auto)"
                        aria-label="Code mnemonic (optional)"
                        className="w-full bg-transparent px-3 py-1.5 font-mono text-xs outline-none focus:bg-foreground/5"
                      />
                    </td>
                    <td className="align-top">
                      <input
                        ref={setCellRef(r.id, 'definition')}
                        value={r.definition}
                        onChange={(e) => updateCell(r.id, 'definition', e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r.id, 'definition')}
                        placeholder="one-line definition (optional)"
                        aria-label="Code definition (optional)"
                        className="w-full bg-transparent px-3 py-1.5 outline-none focus:bg-foreground/5"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
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

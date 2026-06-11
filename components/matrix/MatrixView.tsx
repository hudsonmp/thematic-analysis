'use client';

import { useMemo, useState, useActionState } from 'react';
import Link from 'next/link';
import type { CodebookTree, CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { createCodeAction, type NewCodeState } from '@/app/(protected)/actions';
import FacetEditor from './FacetEditor';

const NONE = '__none__';

// Lifecycle status → dot color. Kept inline (not facet-value colors): these are
// the four fixed code statuses, orthogonal to the user-defined facet palette.
const STATUS_COLOR: Record<string, string> = {
  proposed: '#9ca3af', // gray
  active: '#16a34a', // green
  merged: '#2563eb', // blue
  retired: '#dc2626', // red
};

function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? '#9ca3af';
}

function CodeChip({ code }: { code: CodeWithRefs }) {
  return (
    <Link
      href={`/codes/${code.id}`}
      title={`${code.name} (${code.status})`}
      className="inline-flex items-center gap-1.5 border border-foreground/15 px-2 py-0.5 text-xs hover:border-foreground hover:bg-foreground/5 transition max-w-full"
    >
      <span
        className="inline-block h-2 w-2 rounded-full shrink-0"
        style={{ backgroundColor: statusColor(code.status) }}
        aria-hidden
      />
      <span className="truncate font-mono">{code.mnemonic}</span>
    </Link>
  );
}

const initialNewCode: NewCodeState = {};

function NewCodeForm({ codebookId, origins }: { codebookId: string; origins: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(createCodeAction, initialNewCode);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-foreground px-3 py-1.5 text-sm hover:bg-foreground hover:text-background transition"
      >
        New code
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="border border-foreground/20 p-3 space-y-2 max-w-xl"
    >
      <input type="hidden" name="codebookId" value={codebookId} />
      <div className="flex gap-2 flex-wrap">
        <input
          name="mnemonic"
          required
          placeholder="mnemonic (e.g. SPEC-GAP)"
          className="border border-foreground/15 px-2 py-1 text-sm bg-background font-mono w-44"
        />
        <input
          name="name"
          required
          placeholder="name"
          className="border border-foreground/15 px-2 py-1 text-sm bg-background flex-1 min-w-40"
        />
        <select
          name="origin"
          defaultValue="emergent"
          className="border border-foreground/15 px-2 py-1 text-sm bg-background"
          aria-label="Code origin"
        >
          {origins.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      <textarea
        name="definition"
        required
        rows={2}
        placeholder="one-line definition (full anatomy editable on the code page)"
        className="w-full border border-foreground/15 px-2 py-1 text-sm bg-background"
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="border border-foreground px-3 py-1 text-sm hover:bg-foreground hover:text-background transition disabled:opacity-50"
        >
          {isPending ? 'Creating…' : 'Create code'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={isPending}
          className="border border-foreground/30 px-3 py-1 text-sm text-foreground/60 hover:text-foreground transition disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const ORIGINS = ['a_priori', 'pilot', 'emergent'] as const;

/**
 * The scheme / matrix view. Pivots codes onto a 2-D grid keyed by two chosen
 * facets.
 *
 * Pivot model: a code is tagged with a flat set of `facetValueIds`. For a given
 * (rowFacet, colFacet) selection we build, per code, the set of value-ids it
 * carries on EACH axis facet. A code lands in cell (rv, cv) iff its
 * facetValueIds include both `rv` and `cv`. A code can carry multiple values on
 * one facet (multi cardinality), so it can legitimately appear in several cells
 * — that's faithful, not a bug.
 *
 * "none" on an axis collapses that axis to a single lane (the axis is ignored),
 * so picking none/none shows every code in one cell.
 *
 * Unassigned lane: codes missing ANY value on a selected axis facet would
 * vanish from the grid (no cell matches). We surface them in a dedicated lane
 * so no code is silently lost. The lane lists codes that are missing a value on
 * the row facet, the col facet, or both (deduped).
 */
export default function MatrixView({ tree }: { tree: CodebookTree }) {
  const { codebook, facets, codes } = tree;

  const [rowFacetId, setRowFacetId] = useState<string>(facets[0]?.id ?? NONE);
  const [colFacetId, setColFacetId] = useState<string>(facets[1]?.id ?? NONE);

  const facetById = useMemo(() => {
    const m = new Map<string, FacetWithValues>();
    for (const f of facets) m.set(f.id, f);
    return m;
  }, [facets]);

  const rowFacet = rowFacetId === NONE ? null : facetById.get(rowFacetId) ?? null;
  const colFacet = colFacetId === NONE ? null : facetById.get(colFacetId) ?? null;

  // Free-text filter on the code set: case-insensitive substring over mnemonic
  // or name. Empty query = all codes. This is the ONLY code filter (it replaces
  // any facet-based filtering); the pivot/cell logic below operates over the
  // filtered set, so non-matching codes simply don't render in any cell or the
  // unassigned lane.
  const [query, setQuery] = useState('');
  const visibleCodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter(
      (c) =>
        c.mnemonic.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    );
  }, [codes, query]);

  // Per code, the value-ids it carries on a given facet (intersection of the
  // code's tagged value-ids with that facet's value-ids).
  const valueIdsOnFacet = useMemo(() => {
    const facetValueSet = new Map<string, Set<string>>();
    for (const f of facets) facetValueSet.set(f.id, new Set(f.values.map((v) => v.id)));

    const map = new Map<string, Map<string, string[]>>(); // codeId -> facetId -> valueIds
    for (const code of visibleCodes) {
      const perFacet = new Map<string, string[]>();
      const tagged = new Set(code.facetValueIds);
      for (const f of facets) {
        const vs = facetValueSet.get(f.id)!;
        const hit = [...tagged].filter((id) => vs.has(id));
        perFacet.set(f.id, hit);
      }
      map.set(code.id, perFacet);
    }
    return map;
  }, [visibleCodes, facets]);

  function valuesFor(codeId: string, facetId: string): string[] {
    return valueIdsOnFacet.get(codeId)?.get(facetId) ?? [];
  }

  // Rows/cols are the selected facet's values, plus a single synthetic lane when
  // the axis is "none".
  const rowCells = rowFacet ? rowFacet.values : [{ id: NONE, label: 'All', color: null }];
  const colCells = colFacet ? colFacet.values : [{ id: NONE, label: 'All', color: null }];

  // codes that land in cell (rowValueId, colValueId).
  function codesInCell(rowValueId: string, colValueId: string): CodeWithRefs[] {
    return visibleCodes.filter((code) => {
      const rowOk = !rowFacet || valuesFor(code.id, rowFacet.id).includes(rowValueId);
      const colOk = !colFacet || valuesFor(code.id, colFacet.id).includes(colValueId);
      return rowOk && colOk;
    });
  }

  // Unassigned: missing a value on a selected axis facet.
  const unassigned = useMemo(() => {
    return visibleCodes.filter((code) => {
      const rowMissing = rowFacet ? valuesFor(code.id, rowFacet.id).length === 0 : false;
      const colMissing = colFacet ? valuesFor(code.id, colFacet.id).length === 0 : false;
      return rowMissing || colMissing;
    });
    // valuesFor is derived from valueIdsOnFacet; deps captured via that + facets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCodes, rowFacet, colFacet, valueIdsOnFacet]);

  const noFacets = facets.length === 0;
  const noCodes = codes.length === 0;

  return (
    <main className="flex-1 px-6 py-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-xl font-medium tracking-tight">Scheme</h1>
        <NewCodeForm codebookId={codebook.id} origins={ORIGINS} />
      </div>

      <p className="max-w-3xl text-sm leading-relaxed text-foreground/60 border-l-2 border-foreground/15 pl-3">
        A <span className="font-medium text-foreground/80">facet</span> is a
        dimension you organize codes by (e.g.{' '}
        <span className="font-mono text-foreground/70">Stage</span>,{' '}
        <span className="font-mono text-foreground/70">Locus</span>). Each facet
        has <span className="font-medium text-foreground/80">values</span> (e.g.{' '}
        Monitor, Diagnose). Tag codes with values, then pivot the matrix by any
        two facets.
      </p>

      <FacetEditor codebookId={codebook.id} facets={facets} />

      {noFacets ? (
        <div className="border border-dashed border-foreground/20 p-8 text-center text-sm text-foreground/60">
          No facets yet. Open <span className="font-medium text-foreground">Edit scheme</span> above
          to create your first facet (e.g. a <span className="font-mono">phase</span> or{' '}
          <span className="font-mono">layer</span> dimension), then add values to it. The matrix
          pivots codes across two facets.
        </div>
      ) : (
        <>
          {/* Search: free-text filter on which codes render in the grid. */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search codes by mnemonic or name…"
              aria-label="Search codes"
              className="border border-foreground/15 px-2 py-1 text-sm bg-background w-72 max-w-full"
            />
            {query.trim() && (
              <span className="text-foreground/40 text-xs">
                {visibleCodes.length} of {codes.length} match
              </span>
            )}
          </div>

          {/* Axis selectors */}
          <div className="flex items-center gap-6 text-sm flex-wrap">
            <label className="flex items-center gap-2">
              <span className="text-foreground/60">Rows</span>
              <select
                value={rowFacetId}
                onChange={(e) => setRowFacetId(e.target.value)}
                className="border border-foreground/15 px-2 py-1 bg-background"
              >
                <option value={NONE}>none</option>
                {facets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-foreground/60">Columns</span>
              <select
                value={colFacetId}
                onChange={(e) => setColFacetId(e.target.value)}
                className="border border-foreground/15 px-2 py-1 bg-background"
              >
                <option value={NONE}>none</option>
                {facets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-foreground/40 text-xs">
              {codes.length} code{codes.length === 1 ? '' : 's'}
            </span>
          </div>

          {/* Grid */}
          <div className="overflow-x-auto border border-foreground/15">
            <table className="border-collapse w-full text-sm">
              <thead>
                <tr>
                  <th className="border-b border-r border-foreground/15 bg-foreground/5 px-3 py-2 text-left text-xs uppercase tracking-wider text-foreground/50">
                    {rowFacet?.label ?? ''}
                    {colFacet ? ` \\ ${colFacet.label}` : ''}
                  </th>
                  {colCells.map((cv) => (
                    <th
                      key={cv.id}
                      className="border-b border-r border-foreground/15 bg-foreground/5 px-3 py-2 text-left align-bottom min-w-40"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {'color' in cv && cv.color && (
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-sm"
                            style={{ backgroundColor: cv.color }}
                            aria-hidden
                          />
                        )}
                        {cv.label}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowCells.map((rv) => (
                  <tr key={rv.id}>
                    <th className="border-b border-r border-foreground/15 bg-foreground/5 px-3 py-2 text-left align-top whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        {'color' in rv && rv.color && (
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-sm"
                            style={{ backgroundColor: rv.color }}
                            aria-hidden
                          />
                        )}
                        {rv.label}
                      </span>
                    </th>
                    {colCells.map((cv) => {
                      const cell = codesInCell(rv.id, cv.id);
                      return (
                        <td
                          key={cv.id}
                          className="border-b border-r border-foreground/15 px-2 py-2 align-top min-w-40"
                        >
                          <div className="flex flex-wrap gap-1.5">
                            {cell.map((code) => (
                              <CodeChip key={code.id} code={code} />
                            ))}
                            {cell.length === 0 && (
                              <span className="text-foreground/20 text-xs">—</span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {noCodes && (
            <p className="text-sm text-foreground/60">
              No codes yet — use <span className="font-medium text-foreground">New code</span> above
              to add one. Tag it with facet values on its code page to place it in the grid.
            </p>
          )}

          {/* Unassigned lane */}
          {unassigned.length > 0 && (
            <section className="border border-amber-500/40 bg-amber-500/5 p-3">
              <h2 className="text-xs uppercase tracking-wider text-amber-700 mb-2">
                Unassigned · {unassigned.length} code{unassigned.length === 1 ? '' : 's'} missing a
                value on a selected axis
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {unassigned.map((code) => (
                  <CodeChip key={code.id} code={code} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

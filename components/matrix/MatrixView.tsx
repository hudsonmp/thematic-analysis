'use client';

import { useMemo, useState, useActionState } from 'react';
import Link from 'next/link';
import type { CodebookTree, CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { createCodeAction, type NewCodeState } from '@/app/(protected)/actions';
import { filterCodes } from '@/lib/codebook/filter';
import type { Tables } from '@/lib/types/cb-db';
import FacetEditor from './FacetEditor';

type Citation = Tables<'cb_citations'>;

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

function citationLabel(c: Citation): string {
  const head = c.bibtex_key || c.title || c.id;
  const meta = [c.title && c.title !== head ? c.title : null, c.authors, c.year]
    .filter(Boolean)
    .join(' · ');
  return meta ? `${head} — ${meta}` : head;
}

/**
 * Searchable, multi-select citation picker for the new-code form (Feature #9).
 * Picked citation ids are emitted as repeated hidden `citationIds` inputs so the
 * server action reads them via `formData.getAll('citationIds')`. The text box
 * filters the codebook's citation library by bibtex_key / title / authors. With
 * an empty library it shows a pointer to the Citations page; create still works.
 */
function CitationPicker({ citations }: { citations: Citation[] }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return citations;
    return citations.filter((c) =>
      [c.bibtex_key, c.title, c.authors]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle)),
    );
  }, [citations, q]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (citations.length === 0) {
    return (
      <p className="text-xs text-foreground/50">
        No citations yet —{' '}
        <Link href="/citations" className="underline hover:text-foreground">
          add them in Citations
        </Link>
        .
      </p>
    );
  }

  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs uppercase tracking-wider text-foreground/50">
        Citations <span className="text-foreground/30 normal-case">(optional · derived from)</span>
      </legend>
      {/* Hidden inputs carry the picked ids into the form submission. */}
      {[...picked].map((id) => (
        <input key={id} type="hidden" name="citationIds" value={id} />
      ))}
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search citations by key, title, or author…"
        aria-label="Search citations"
        className="w-full border border-foreground/15 px-2 py-1 text-xs bg-background"
      />
      <div className="max-h-40 overflow-y-auto border border-foreground/10 divide-y divide-foreground/10">
        {filtered.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-foreground/30">No citations match.</p>
        )}
        {filtered.map((c) => {
          const isOn = picked.has(c.id);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => toggle(c.id)}
              aria-pressed={isOn}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition ${
                isOn ? 'bg-foreground text-background' : 'hover:bg-foreground/5'
              }`}
            >
              <span
                className={`inline-block h-3 w-3 shrink-0 border ${
                  isOn ? 'border-background bg-background' : 'border-foreground/40'
                }`}
                aria-hidden
              />
              <span className="truncate">{citationLabel(c)}</span>
            </button>
          );
        })}
      </div>
      {picked.size > 0 && (
        <p className="text-xs text-foreground/40">
          {picked.size} citation{picked.size === 1 ? '' : 's'} will link on create.
        </p>
      )}
    </fieldset>
  );
}

function NewCodeForm({
  codebookId,
  origins,
  citations,
  boundCitation,
}: {
  codebookId: string;
  origins: readonly string[];
  citations: Citation[];
  /**
   * When set, the form is in "code from citation" (deductive) mode: every code
   * created auto-links `derived_from` to this paper and defaults origin to
   * `a_priori`. The binding persists across successive creates (the action
   * redirects back to `/?fromCitation=<id>`), so the form auto-opens here and
   * shows the locked citation instead of the multi-select picker.
   */
  boundCitation: Citation | null;
}) {
  const bound = boundCitation !== null;
  const [open, setOpen] = useState(bound);
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
      {/* Bound mode: carry the paper id so the action redirects back to
          /?fromCitation=<id> (binding persists across creates). The single
          hidden citationIds input guarantees the derived_from link without the
          multi-select picker — and avoids any double-link. */}
      {bound && <input type="hidden" name="fromCitation" value={boundCitation.id} />}
      {bound && <input type="hidden" name="citationIds" value={boundCitation.id} />}
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
          defaultValue={bound ? 'a_priori' : 'emergent'}
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
      {bound ? (
        <p className="text-xs text-foreground/50">
          Linking{' '}
          <span className="font-medium text-foreground/80">derived from</span>{' '}
          <span className="font-mono text-foreground/70">
            {boundCitation.bibtex_key ?? boundCitation.title ?? boundCitation.id}
          </span>
          .
        </p>
      ) : (
        <CitationPicker citations={citations} />
      )}
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
export default function MatrixView({
  tree,
  boundCitation = null,
}: {
  tree: CodebookTree;
  /**
   * Deductive "code from citation" mode. When non-null, the matrix shows a
   * banner naming the paper and the new-code form binds every create to it
   * (auto-link derived_from + default origin a_priori, persisting across
   * creates). Defaults to null so existing call sites (and tests) are
   * unaffected.
   */
  boundCitation?: Citation | null;
}) {
  const { codebook, facets, codes, episodes, labels, citations } = tree;

  const [rowFacetId, setRowFacetId] = useState<string>(facets[0]?.id ?? NONE);
  const [colFacetId, setColFacetId] = useState<string>(facets[1]?.id ?? NONE);

  const facetById = useMemo(() => {
    const m = new Map<string, FacetWithValues>();
    for (const f of facets) m.set(f.id, f);
    return m;
  }, [facets]);

  const rowFacet = rowFacetId === NONE ? null : facetById.get(rowFacetId) ?? null;
  const colFacet = colFacetId === NONE ? null : facetById.get(colFacetId) ?? null;

  // Code-set filters, composed by AND in `filterCodes` (lib/codebook/filter):
  //   - free-text query: case-insensitive substring over mnemonic or name;
  //   - episode filter: when an episode is picked, only codes tagged with it
  //     (temporal axis);
  //   - label filter: when a label is picked, only codes grouped under it
  //     (categorical / "what kind" axis, orthogonal to episodes).
  // Empty query + NONE episode + NONE label = all codes. The pivot/cell logic
  // below operates over the filtered set, so non-matching codes simply don't
  // render in any cell or the unassigned lane.
  //   - citation filter: when a citation is picked, only codes linked to it via
  //     the built-in virtual "Citations" facet (reuses each code's `citationIds`
  //     from the tree — no refetch; reflects links of any role).
  const [query, setQuery] = useState('');
  const [episodeId, setEpisodeId] = useState<string>(NONE);
  const [labelId, setLabelId] = useState<string>(NONE);
  const [citationId, setCitationId] = useState<string>(NONE);
  const visibleCodes = useMemo(
    () =>
      filterCodes(
        codes,
        query,
        episodeId === NONE ? null : episodeId,
        labelId === NONE ? null : labelId,
        citationId === NONE ? null : citationId,
      ),
    [codes, query, episodeId, labelId, citationId],
  );

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
      {/* Deductive-coding banner: present iff the page resolved a ?fromCitation
          paper. "× exit" clears the binding by navigating to the bare matrix. */}
      {boundCitation && (
        <div className="flex items-center justify-between gap-3 border border-foreground/30 bg-foreground/5 px-3 py-2 text-sm">
          <span className="min-w-0">
            <span className="text-foreground/60">Deriving codes from:</span>{' '}
            <span className="font-mono text-foreground/90">
              {boundCitation.bibtex_key ?? boundCitation.title ?? boundCitation.id}
            </span>
            {boundCitation.bibtex_key && boundCitation.title && (
              <span className="text-foreground/50"> — {boundCitation.title}</span>
            )}
          </span>
          <Link
            href="/"
            title="Exit coding-from-paper mode"
            className="shrink-0 border border-foreground/30 px-2 py-0.5 text-xs hover:bg-foreground hover:text-background transition"
          >
            × exit
          </Link>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-xl font-medium tracking-tight">Scheme</h1>
        <NewCodeForm
          codebookId={codebook.id}
          origins={ORIGINS}
          citations={citations}
          boundCitation={boundCitation}
        />
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
          {/* Filters: free-text search + episode filter + label filter,
              composed by AND, on which codes render in the grid. */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search codes by mnemonic or name…"
              aria-label="Search codes"
              className="border border-foreground/15 px-2 py-1 text-sm bg-background w-72 max-w-full"
            />
            {episodes.length > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-foreground/60">Event</span>
                <select
                  value={episodeId}
                  onChange={(e) => setEpisodeId(e.target.value)}
                  aria-label="Filter codes by event"
                  className="border border-foreground/15 px-2 py-1 bg-background"
                >
                  <option value={NONE}>all</option>
                  {episodes.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {labels.length > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-foreground/60">Label</span>
                <select
                  value={labelId}
                  onChange={(e) => setLabelId(e.target.value)}
                  aria-label="Filter codes by label"
                  className="border border-foreground/15 px-2 py-1 bg-background"
                >
                  <option value={NONE}>all</option>
                  {labels.map((lbl) => (
                    <option key={lbl.id} value={lbl.id}>
                      {lbl.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {/* Built-in virtual "Citations" facet, as a filter dimension. Backed
                by each code's `citationIds` (already on the tree — no refetch);
                picking a paper shows only codes linked to it (any link role). */}
            {citations.length > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-foreground/60">Citation</span>
                <select
                  value={citationId}
                  onChange={(e) => setCitationId(e.target.value)}
                  aria-label="Filter codes by citation"
                  className="border border-foreground/15 px-2 py-1 bg-background"
                >
                  <option value={NONE}>all</option>
                  {citations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.bibtex_key || c.title || c.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(query.trim() ||
              episodeId !== NONE ||
              labelId !== NONE ||
              citationId !== NONE) && (
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

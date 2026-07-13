'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  deleteFacetValue,
  interposeFacetValue,
  updateFacetValue,
} from '@/app/actions/facets';
import { addCodeFacetValue, removeCodeFacetValue } from '@/app/actions/codes';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { searchCodes } from '@/lib/codebook/codePicker';
import { buildTree } from '@/lib/codebook/tree';
import { answersFacet, rollUpByValue } from '@/lib/codebook/inheritance';
import { ancestorsOf, layoutTree, subtreeAt, type LayoutNode } from '@/lib/codebook/treeLayout';
import FacetEditor from '@/components/matrix/FacetEditor';
import type { Tables } from '@/lib/types/cb-db';
import NewCodeDialog, { type DialogTarget } from './NewCodeDialog';
import TriageQueue from './TriageQueue';

type FacetValue = Tables<'cb_facet_values'>;
type Citation = Tables<'cb_citations'>;

const COL = 190;
const ROW = 132;

type Selection = { kind: 'value'; id: string } | { kind: 'code'; id: string } | null;

/**
 * The codebook canvas. It renders ONE FACET'S VALUE CHAIN.
 *
 *   FACET — a dimension. A question askable of every code ("which space is this
 *           code about?"). Switching facet switches the whole tree.
 *   VALUE — an answer. Values NEST, so the tree is a taxonomy INSIDE one dimension
 *           (Ranganathan's chain) — which is what a tree is genuinely good at.
 *   CODE  — carries values. It renders as a chip on each value it answers.
 *
 * The thing this buys, and the reason the old arbitrary construct tree was replaced:
 * a code that cross-cuts — "confirmation bias while reviewing a hypothesis against an
 * experiment" — simply carries TWO values on one dimension. It is ONE code, one row,
 * appearing wherever it belongs. Under a tree it could only be expressed by
 * DUPLICATING it into two branches, which records two memberships and destroys the
 * fact that it is one phenomenon.
 *
 * Facets never nest under one another. A facet conditional on another facet's value
 * would be a hierarchy in disguise, and would bring the cross-classification problem
 * straight back.
 *
 * Interaction:
 *   click value/code   → inspect it
 *   ⌘/Ctrl-click value → zoom into its sub-chain (ancestors stay visible + clickable)
 *   `+` on a value     → a new code answering it, an existing code, or a sub-value
 *   `+` in the header  → a new top-level value of this facet
 *   corner `+`         → a floating code: no answers yet, triage it later
 */
export default function FacetCanvas({
  codebookId,
  facets,
  codes,
  citations,
}: {
  codebookId: string;
  facets: FacetWithValues[];
  codes: CodeWithRefs[];
  citations: Citation[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  // Only ENUM facets have values, so only they can be drawn. A boolean/open_text
  // facet is a per-code field, not a dimension — it partitions nothing.
  const dimensions = useMemo(() => facets.filter((f) => f.type === 'enum'), [facets]);

  const [facetId, setFacetId] = useState<string | null>(dimensions[0]?.id ?? null);
  const facet = dimensions.find((f) => f.id === facetId) ?? dimensions[0] ?? null;

  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [interposeAt, setInterposeAt] = useState<string | null>(null);
  const [pinnedCitationId, setPinnedCitationId] = useState<string | null>(null);
  const [schemeOpen, setSchemeOpen] = useState(dimensions.length === 0);
  // The right rail holds BOTH the inspector and the triage queue, and can be closed
  // outright — the canvas is the thinking surface, and a panel you cannot dismiss
  // permanently taxes the width you think in.
  const [railOpen, setRailOpen] = useState(true);
  const [rail, setRail] = useState<'inspect' | 'queue'>('inspect');

  const values: FacetValue[] = useMemo(() => facet?.values ?? [], [facet]);

  // The value chain, folded and mapped into the geometry's minimal shape. A value's
  // display name is its `label`; the layout does not care what kind of row it is.
  const forest: LayoutNode[] = useMemo(() => {
    const toLayout = (n: FacetValue & { children: unknown[] }): LayoutNode => ({
      id: n.id,
      name: n.label,
      children: (n.children as (FacetValue & { children: unknown[] })[]).map(toLayout),
    });
    return buildTree(values).map((n) => toLayout(n as never));
  }, [values]);

  // Codes on each value, DIRECT and INHERITED. A facet's values are an IS-A chain, so
  // a code answering `Design` genuinely answers `Experiment` — entailment, not a
  // display convenience. A parent therefore shows its subtree's codes, and the two
  // kinds stay distinct because they are different claims: a code pinned AT the parent
  // said "this granularity, and I decline to be finer".
  const rolled = useMemo(
    () => rollUpByValue(values, codes, (c) => c.facetValueIds),
    [values, codes],
  );

  const countByValue = useMemo(
    () =>
      new Map(
        [...rolled].map(([k, v]) => [k, v.direct.length + v.inherited.length] as const),
      ),
    [rolled],
  );

  const valueById = useMemo(() => new Map(values.map((v) => [v.id, v])), [values]);
  const codeById = useMemo(() => new Map(codes.map((c) => [c.id, c])), [codes]);

  // Names for EVERY value across ALL facets — the picker must be able to say "this
  // code already answers Experiment on the Space dimension", even while you are
  // looking at a different dimension.
  const valueNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of dimensions) for (const v of f.values) m.set(v.id, v.label);
    return m;
  }, [dimensions]);

  /** Codes with NO answer anywhere on THIS dimension. A code answering only a CHILD
   *  value HAS answered the dimension — demanding an answer it already gave, more
   *  precisely, would make the queue unclearable. */
  const unansweredHere = useMemo(() => {
    const ids = new Set(values.map((v) => v.id));
    return codes.filter((c) => !answersFacet(c.facetValueIds, ids));
  }, [codes, values]);

  const visibleRoots = useMemo(() => {
    if (focusId === null) return forest;
    const sub = subtreeAt(forest, focusId);
    return sub ? [sub] : forest;
  }, [forest, focusId]);

  const trail = useMemo(
    () => (focusId === null ? [] : ancestorsOf(forest, focusId)),
    [forest, focusId],
  );

  const layout = useMemo(
    () => layoutTree(visibleRoots, countByValue),
    [visibleRoots, countByValue],
  );

  /** Selecting anything re-opens the rail on the inspector: a click whose result is
   *  invisible reads as a broken click. */
  function inspect(next: Selection) {
    setSelected(next);
    setRail('inspect');
    setRailOpen(true);
  }

  function run(fn: () => Promise<unknown>) {
    start(async () => {
      await fn();
      router.refresh();
    });
  }

  const x = (n: number) => n * COL + COL / 2;
  const y = (n: number) => n * ROW + 48;

  return (
    <main className="flex h-[calc(100vh-6rem)]">
      <section className="relative flex min-w-0 flex-1 flex-col">
        {/* ---------------- header ---------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-3 border-b border-foreground/15 px-6 py-2.5">
          {/* Switching facet switches the tree. Each dimension has its own answer
              taxonomy; they are independent, which is what lets one code answer two
              of them without being duplicated anywhere. */}
          <label className="flex items-center gap-2 text-xs">
            <span className="text-foreground/80">Dimension</span>
            <select
              value={facet?.id ?? ''}
              onChange={(e) => {
                setFacetId(e.target.value);
                setFocusId(null);
                setSelected(null);
              }}
              disabled={dimensions.length === 0}
              className="border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none disabled:opacity-50"
            >
              {dimensions.length === 0 && <option value="">no dimensions yet</option>}
              {dimensions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                  {f.cardinality === 'multi' ? ' (multi)' : ''}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            disabled={facet === null}
            onClick={() => setDialog({ kind: 'root' })}
            className="border border-foreground px-2.5 py-1 text-xs transition enabled:hover:bg-foreground enabled:hover:text-background disabled:opacity-40"
          >
            + New value
          </button>

          <button
            type="button"
            onClick={() => setSchemeOpen((s) => !s)}
            aria-expanded={schemeOpen}
            className="border border-foreground/20 px-2.5 py-1 text-xs transition hover:border-foreground"
          >
            {schemeOpen ? 'Hide dimensions' : 'Edit dimensions'}
            <span className="ml-1 text-foreground/40">({dimensions.length})</span>
          </button>

          <label className="flex items-center gap-2 text-xs text-foreground/60">
            <span className="text-foreground/80">Pin paper</span>
            <select
              value={pinnedCitationId ?? ''}
              onChange={(e) => setPinnedCitationId(e.target.value || null)}
              className="border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
            >
              <option value="">off</option>
              {citations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.bibtex_key ?? c.title ?? c.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>

          <span className="ml-auto text-xs text-foreground/40">
            click = inspect · ⌘-click = zoom
          </span>
        </div>

        {schemeOpen && (
          <div className="border-b border-foreground/15 bg-foreground/[0.02] px-6 py-3">
            <FacetEditor codebookId={codebookId} facets={facets} />
          </div>
        )}

        {focusId !== null && (
          <div className="flex items-center gap-1.5 border-b border-foreground/10 px-6 py-1.5 text-xs">
            <button
              type="button"
              onClick={() => setFocusId(null)}
              className="text-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
            >
              {facet?.label ?? 'all'}
            </button>
            {trail.map((a) => (
              <span key={a.id} className="flex items-center gap-1.5">
                <span className="text-foreground/25">/</span>
                {/* Blurred, not hidden — an ancestor you cannot click is a dead end. */}
                <button
                  type="button"
                  onClick={() => setFocusId(a.id)}
                  className="text-foreground/40 opacity-70 blur-[0.3px] transition hover:text-foreground hover:opacity-100 hover:blur-0"
                >
                  {a.name}
                </button>
              </span>
            ))}
            <span className="text-foreground/25">/</span>
            <span className="font-medium">{valueById.get(focusId)?.label}</span>
          </div>
        )}

        {/* ---------------- canvas ---------------------------------------------- */}
        {/* Clicking EMPTY canvas captures an uncategorized code. Only a code — a value
            needs a place in the chain, and empty space names none, whereas a code with
            no answers is exactly what the triage queue is for.
            `e.target === e.currentTarget` so a click that landed on a node, a chip or
            the SVG never counts as whitespace. */}
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setDialog({ kind: 'floating' });
          }}
          title="Click empty space to capture an uncategorized code"
          className="relative flex-1 cursor-crosshair overflow-auto bg-foreground/[0.02] p-6">
          {/* A code with NO answers yet, saved for later. It costs nothing and
              interrupts nothing: an idea you have mid-reading should not first demand
              that you decide how to classify it. Deciding is the expensive part;
              deferring it is the feature. It lands in the triage queue. */}
          {dimensions.length === 0 ? (
            <p className="mt-16 text-center text-sm text-foreground/45">
              No dimensions yet. A dimension is a question you can ask of{' '}
              <em>every</em> code — &ldquo;which space is this about?&rdquo;. Open{' '}
              <strong>Edit dimensions</strong> to declare one.
            </p>
          ) : layout.nodes.length === 0 ? (
            <p className="mt-16 text-center text-sm text-foreground/45">
              <strong>{facet?.label}</strong> has no answers yet.{' '}
              <strong>+ New value</strong> adds one.
            </p>
          ) : (
            <div
              className="relative"
              style={{
                width: Math.max(layout.width, 1) * COL,
                height: layout.height * ROW + 60,
              }}
            >
              <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
                {layout.edges.map((e) => {
                  const p = layout.nodes.find((n) => n.id === e.parentId)!;
                  const c = layout.nodes.find((n) => n.id === e.childId)!;
                  return (
                    <line
                      key={`${e.parentId}-${e.childId}`}
                      x1={x(p.x)}
                      y1={y(p.y) + 12}
                      x2={x(c.x)}
                      y2={y(c.y) - 14}
                      stroke="currentColor"
                      className="text-foreground/30"
                      strokeWidth={1}
                    />
                  );
                })}
              </svg>

              {layout.nodes.map((n) => {
                const bucket = rolled.get(n.id) ?? { direct: [], inherited: [] };
                const isSel = selected?.kind === 'value' && selected.id === n.id;
                return (
                  <div
                    key={n.id}
                    className="absolute -translate-x-1/2"
                    style={{ left: x(n.x), top: y(n.y) - 14, width: COL - 24 }}
                  >
                    <div className="flex items-center justify-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey) setFocusId(n.id);
                          else inspect({ kind: 'value', id: n.id });
                        }}
                        className={`max-w-full truncate border-b px-1 text-sm transition ${
                          isSel
                            ? 'border-foreground font-medium'
                            : 'border-transparent text-foreground/80 hover:border-foreground/40'
                        }`}
                        title={`${n.name} — click to inspect, ⌘-click to zoom`}
                      >
                        {n.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: 'child', id: n.id, name: n.name })}
                        className="shrink-0 border border-foreground/20 px-1 text-xs leading-4 text-foreground/50 transition hover:border-foreground hover:text-foreground"
                        aria-label={`Add under ${n.name}`}
                        title="Add a code, an existing code, or a sub-value"
                      >
                        +
                      </button>
                    </div>

                    {(bucket.direct.length > 0 || bucket.inherited.length > 0) && (
                      <div className="mt-1 flex flex-wrap justify-center gap-1">
                        {bucket.direct.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => inspect({ kind: 'code', id: c.id })}
                            className={`max-w-full truncate border px-1.5 py-0.5 text-[10px] transition ${
                              selected?.kind === 'code' && selected.id === c.id
                                ? 'border-foreground bg-foreground text-background'
                                : 'border-foreground/25 text-foreground/70 hover:border-foreground'
                            }`}
                            title={`${c.name} — answers this value directly`}
                          >
                            {c.mnemonic}
                          </button>
                        ))}
                        {/* INHERITED: answers a sub-value, so it answers this one too.
                            Dashed, because it is a weaker kind of presence — the code
                            said something MORE precise than this value. */}
                        {bucket.inherited.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => inspect({ kind: 'code', id: c.id })}
                            className={`max-w-full truncate border border-dashed px-1.5 py-0.5 text-[10px] transition ${
                              selected?.kind === 'code' && selected.id === c.id
                                ? 'border-foreground bg-foreground text-background'
                                : 'border-foreground/25 text-foreground/45 hover:border-foreground'
                            }`}
                            title={`${c.name} — answers a sub-value, so it answers this one by entailment`}
                          >
                            {c.mnemonic}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Capture an uncategorized code. Anchored to the SECTION, not the viewport,
            so it can never sit on top of the right rail — which is what it did when it
            was `fixed` and the rail width was hard-coded into its offset. */}
        <button
          type="button"
          onClick={() => setDialog({ kind: 'floating' })}
          title="New code — unclassified, triage it later"
          aria-label="New code"
          className="absolute bottom-6 right-6 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-foreground/20 bg-background text-lg shadow-lg transition hover:border-foreground hover:bg-foreground hover:text-background"
        >
          +
        </button>

      </section>

      {/* ---------------- right rail: inspect | triage --------------------------- */}
      {!railOpen && (
        // A closed rail must leave a way back, and it should say what is WAITING inside
        // — an unread count is the only honest reason to reopen a panel you shut.
        <button
          type="button"
          onClick={() => setRailOpen(true)}
          className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-foreground/15 py-3 text-xs text-foreground/50 transition hover:bg-foreground/[0.03] hover:text-foreground"
          aria-label="Open the side panel"
          title="Open the side panel"
        >
          <span aria-hidden>‹</span>
          {unansweredHere.length > 0 && (
            <span className="rounded-full border border-amber-600/40 px-1 text-[10px] text-amber-700 dark:text-amber-500">
              {unansweredHere.length}
            </span>
          )}
        </button>
      )}

      <aside
        className={`${railOpen ? 'flex' : 'hidden'} w-96 shrink-0 flex-col border-l border-foreground/15`}
      >
        <div className="flex items-center gap-1 border-b border-foreground/15 px-3 py-2">
          {(['inspect', 'queue'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setRail(t)}
              className={`px-2 py-1 text-xs transition ${
                rail === t
                  ? 'border-b border-foreground font-medium text-foreground'
                  : 'text-foreground/50 hover:text-foreground'
              }`}
            >
              {t === 'inspect' ? 'Inspect' : 'Triage'}
              {t === 'queue' && unansweredHere.length > 0 && (
                <span className="ml-1 text-amber-700 dark:text-amber-500">
                  {unansweredHere.length}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRailOpen(false)}
            className="ml-auto px-1 text-lg leading-none text-foreground/40 transition hover:text-foreground"
            aria-label="Close the side panel"
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {rail === 'queue' ? (
          <TriageQueue codes={codes} facets={dimensions} />
        ) : selected === null ? (
          <p className="text-xs leading-relaxed text-foreground/45">
            Click a <strong>value</strong> to edit its description, or a{' '}
            <strong>code</strong> to see what it answers.
            <br />
            <br />A <strong>dimension</strong> is a question askable of every code. A{' '}
            <strong>value</strong> is an answer to it. A code may give{' '}
            <em>two</em> answers on one dimension — that is how a cross-cutting code is
            expressed without duplicating it.
          </p>
        ) : selected.kind === 'value' ? (
          <ValueInspector
            key={selected.id}
            value={valueById.get(selected.id)!}
            childValues={(subtreeAt(forest, selected.id)?.children ?? []).map((c) => ({
              id: c.id,
              name: c.name,
            }))}
            answering={(rolled.get(selected.id) ?? { direct: [] }).direct}
            inherited={(rolled.get(selected.id) ?? { inherited: [] }).inherited}
            allCodes={codes}
            valueNameById={valueNameById}
            pending={pending}
            onAttach={(codeId) => run(() => addCodeFacetValue(codeId, selected.id))}
            onSaveDescription={(d) =>
              run(() => updateFacetValue(selected.id, { description: d }))
            }
            onZoom={() => setFocusId(selected.id)}
            onInterpose={() => setInterposeAt(selected.id)}
            onDissolve={() =>
              run(async () => {
                await deleteFacetValue(selected.id);
                setSelected(null);
                if (focusId === selected.id) setFocusId(null);
              })
            }
            onDetach={(codeId) => run(() => removeCodeFacetValue(codeId, selected.id))}
          />
        ) : (
          <CodeInspector
            code={codeById.get(selected.id)!}
            facets={dimensions}
            valueNameById={valueNameById}
          />
        )}
        </div>
      </aside>

      {dialog !== null && facet !== null && (
        <NewCodeDialog
          codebookId={codebookId}
          facetId={facet.id}
          target={dialog}
          facets={dimensions}
          codes={codes}
          nodeNameById={valueNameById}
          pinnedCitationId={pinnedCitationId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}

      {interposeAt !== null && facet !== null && (
        <InterposeDialog
          parentLabel={valueById.get(interposeAt)!.label}
          candidates={(subtreeAt(forest, interposeAt)?.children ?? []).map((c) => ({
            id: c.id,
            name: c.name,
          }))}
          onClose={() => setInterposeAt(null)}
          onSubmit={(label, childIds) =>
            run(async () => {
              await interposeFacetValue(facet.id, {
                parentId: interposeAt,
                label,
                childIds,
              });
              setInterposeAt(null);
            })
          }
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function ValueInspector({
  value,
  childValues,
  answering,
  inherited,
  allCodes,
  valueNameById,
  pending,
  onAttach,
  onSaveDescription,
  onZoom,
  onInterpose,
  onDissolve,
  onDetach,
}: {
  value: FacetValue;
  childValues: { id: string; name: string }[];
  /** Codes answering THIS value outright. */
  answering: CodeWithRefs[];
  /** Codes answering a SUB-value, and so answering this one by entailment. */
  inherited: CodeWithRefs[];
  allCodes: CodeWithRefs[];
  valueNameById: ReadonlyMap<string, string>;
  pending: boolean;
  onAttach: (codeId: string) => void;
  onSaveDescription: (d: string) => void;
  onZoom: () => void;
  onInterpose: () => void;
  onDissolve: () => void;
  onDetach: (codeId: string) => void;
}) {
  const [description, setDescription] = useState(value.description ?? '');
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);

  // Placement status is computed against THIS value: a code already answering it is
  // shown greyed rather than hidden, and one that answers other values is flagged —
  // adding it here means the code gives TWO answers on this dimension, which is the
  // legitimate cross-cutting case and must never be a surprise.
  const hits = useMemo(
    () =>
      picking
        ? searchCodes(
            allCodes.map((c) => ({ ...c, labelIds: c.facetValueIds })),
            query,
            value.id,
            valueNameById,
          )
        : [],
    [picking, allCodes, query, value.id, valueNameById],
  );

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-foreground/40">Value</p>
        <h2 className="text-base font-medium tracking-tight">{value.label}</h2>
      </div>

      <div className="space-y-1">
        <label className="block text-xs font-medium text-foreground/80">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() =>
            description !== (value.description ?? '') && onSaveDescription(description)
          }
          rows={5}
          placeholder="What does this answer cover — and what does it deliberately NOT cover?"
          className="w-full border border-foreground/20 bg-background px-2 py-1.5 text-sm focus:border-foreground focus:outline-none"
        />
        <p className="text-xs text-foreground/40">Saves on blur.</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onZoom}
          className="border border-foreground/20 px-2 py-1 text-xs transition hover:border-foreground"
        >
          Zoom in
        </button>
        <button
          type="button"
          onClick={onInterpose}
          disabled={childValues.length === 0}
          title={
            childValues.length === 0
              ? 'Nothing to pull down — this value has no sub-values'
              : 'Insert an intermediate answer above some of these sub-values'
          }
          className="border border-foreground/20 px-2 py-1 text-xs transition enabled:hover:border-foreground disabled:opacity-40"
        >
          Interpose…
        </button>
        <button
          type="button"
          onClick={onDissolve}
          disabled={pending}
          title="Delete this value; its sub-values collapse up one level (the inverse of interpose). Codes are untouched."
          className="border border-foreground/20 px-2 py-1 text-xs text-foreground/60 transition hover:border-red-500 hover:text-red-600"
        >
          Dissolve
        </button>
      </div>

      {answering.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground/80">
            Codes answering this ({answering.length})
          </p>
          {answering.map((c) => (
            <div key={c.id} className="flex items-center gap-2 text-xs">
              <Link
                href={`/codes/${c.id}`}
                className="min-w-0 flex-1 truncate underline-offset-2 hover:underline"
              >
                <span className="font-mono">{c.mnemonic}</span>{' '}
                <span className="text-foreground/60">{c.name}</span>
              </Link>
              <button
                type="button"
                onClick={() => onDetach(c.id)}
                title="Remove this answer only. The code's answers on other dimensions stay; the code is not deleted."
                className="shrink-0 text-foreground/40 hover:text-red-600"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {inherited.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground/80">
            Inherited from sub-values ({inherited.length})
          </p>
          <p className="text-xs leading-snug text-foreground/40">
            These answer a finer value below, so they answer this one too. They are not
            pinned here and cannot be detached here.
          </p>
          {inherited.map((c) => (
            <Link
              key={c.id}
              href={`/codes/${c.id}`}
              className="block truncate text-xs text-foreground/50 underline-offset-2 hover:underline"
            >
              <span className="font-mono">{c.mnemonic}</span> {c.name}
            </Link>
          ))}
        </div>
      )}

      <div className="space-y-1.5 border-t border-foreground/10 pt-3">
        {!picking ? (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="w-full border border-dashed border-foreground/30 px-2 py-1.5 text-xs text-foreground/60 transition hover:border-foreground hover:text-foreground"
          >
            + An existing code answers this
          </button>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search all codes…"
                className="min-w-0 flex-1 border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  setPicking(false);
                  setQuery('');
                }}
                className="shrink-0 text-xs text-foreground/40 hover:text-foreground"
              >
                done
              </button>
            </div>
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {hits.length === 0 && (
                <p className="py-2 text-xs italic text-foreground/40">No code matches.</p>
              )}
              {hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  disabled={h.status === 'here' || pending}
                  onClick={() => onAttach(h.id)}
                  className={`w-full border px-1.5 py-1 text-left text-xs transition ${
                    h.status === 'here'
                      ? 'cursor-default border-transparent text-foreground/30'
                      : 'border-transparent hover:border-foreground/30 hover:bg-foreground/[0.03]'
                  }`}
                >
                  <span className="font-mono">{h.mnemonic}</span>{' '}
                  <span className="text-foreground/60">{h.name}</span>
                  {h.status === 'here' && (
                    <span className="ml-1 text-foreground/30">· already answers this</span>
                  )}
                  {h.status === 'elsewhere' && (
                    <span className="ml-1 text-foreground/45">
                      · also answers {h.otherNodes.join(', ')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CodeInspector({
  code,
  facets,
  valueNameById,
}: {
  code: CodeWithRefs;
  facets: FacetWithValues[];
  valueNameById: ReadonlyMap<string, string>;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-foreground/40">Code</p>
        <h2 className="text-base font-medium tracking-tight">
          <span className="font-mono text-sm text-foreground/60">{code.mnemonic}</span>{' '}
          {code.name}
        </h2>
        <p className="mt-0.5 text-xs text-foreground/50">
          {code.origin.replace('_', ' ')} · {code.status}
        </p>
      </div>

      {code.current?.definition && (
        <div>
          <p className="text-xs font-medium text-foreground/80">Definition</p>
          <p className="mt-0.5 text-sm leading-relaxed text-foreground/75">
            {code.current.definition}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground/80">Answers</p>
        {facets.map((f) => {
          const mine = f.values
            .filter((v) => code.facetValueIds.includes(v.id))
            .map((v) => valueNameById.get(v.id) ?? v.label);
          return (
            <div key={f.id} className="text-xs">
              <span className="text-foreground/55">{f.label}</span>
              <span className="mx-1 text-foreground/25">·</span>
              <span className={mine.length > 0 ? '' : 'text-foreground/30'}>
                {mine.length > 0 ? mine.join(', ') : 'unanswered'}
              </span>
              {mine.length > 1 && (
                // Two answers on ONE dimension. Legitimate — this is the cross-cutting
                // case the facet model exists to express — but worth naming, because
                // it means per-value counts on this dimension will not sum to N.
                <span className="ml-1 text-amber-700 dark:text-amber-500">
                  · cross-cuts
                </span>
              )}
            </div>
          );
        })}
      </div>

      <Link
        href={`/codes/${code.id}`}
        className="inline-block border border-foreground/20 px-2 py-1 text-xs transition hover:border-foreground"
      >
        Full anatomy →
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------

function InterposeDialog({
  parentLabel,
  candidates,
  onClose,
  onSubmit,
}: {
  parentLabel: string;
  /** Named `candidates`, not `children`: a prop called `children` shadows React's own. */
  candidates: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (label: string, childIds: string[]) => void;
}) {
  const [label, setLabel] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md border border-foreground/20 bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-foreground/15 px-4 py-3">
          <h2 className="text-sm font-medium tracking-tight">
            Interpose a value under {parentLabel}
          </h2>
          <p className="mt-0.5 text-xs text-foreground/50">
            Too granular? Pull some of these sub-values down under a new intermediate
            answer. No code is touched — a code answers a value, and re-parenting a
            value changes none of those answers.
          </p>
        </div>

        <div className="space-y-3 px-4 py-4">
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name of the new intermediate value"
            className="w-full border border-foreground/20 bg-background px-2 py-1.5 text-sm focus:border-foreground focus:outline-none"
          />
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground/80">Sub-values to pull down</p>
            {candidates.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.includes(c.id)}
                  onChange={(e) =>
                    setPicked((s) =>
                      e.target.checked ? [...s, c.id] : s.filter((id) => id !== c.id),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
            <p className="pt-1 text-xs text-foreground/40">
              Unselected sub-values stay where they are.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-foreground/15 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-foreground/60 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(label, picked)}
            disabled={!label.trim() || picked.length === 0}
            className="border border-foreground bg-foreground px-4 py-1.5 text-sm text-background transition hover:opacity-90 disabled:opacity-40"
          >
            Interpose
          </button>
        </div>
      </div>
    </div>
  );
}

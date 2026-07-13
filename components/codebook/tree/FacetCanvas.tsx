'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  createFacetValue,
  deleteFacetValue,
  interposeFacetValue,
  promoteCodeToValue,
  setFacetValueParent,
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
import CodeEditor from './CodeEditor';
import NewCodeDialog, { type DialogTarget } from './NewCodeDialog';
import StagingBox from './StagingBox';
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
  // The triage queue opens as an overlay from the header, like the inspector — neither
  // is a permanent rail, because the canvas is the thinking surface and a panel you
  // cannot dismiss permanently taxes the width you think in.
  const [triageOpen, setTriageOpen] = useState(false);
  // Growing the tree used to mean opening a dialog and picking a tab. A branch is just
  // a name — so a node exposes an inline slot: click the ghost `+`, type, Enter. The
  // dialog is still there for a value that needs a description.
  const [quickBranchAt, setQuickBranchAt] = useState<string | null | undefined>(undefined);
  const [quickBranchName, setQuickBranchName] = useState('');
  // What is currently in flight. Non-null turns the legal targets into drop zones —
  // zones that appear only DURING a drag, so the canvas is not permanently littered with
  // affordances for a gesture you are not making.
  //
  // A code and a VALUE are both draggable, and they mean different things:
  //   code  -> value : this code answers that value
  //   value -> value : re-parent the sub-chain (cycle-guarded server-side)
  const [dragging, setDragging] = useState<
    { kind: 'code'; id: string } | { kind: 'value'; id: string } | null
  >(null);

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

  /** Selecting anything opens the overlay on it. Triage closes: they occupy the same
   *  window, and a click whose result is hidden behind another panel reads as broken. */
  function inspect(next: Selection) {
    setSelected(next);
    setTriageOpen(false);
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
    <main className="relative flex h-[calc(100vh-6rem)]">
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

          <button
            type="button"
            onClick={() => {
              setTriageOpen((o) => !o);
              setSelected(null);
            }}
            className={`border px-2.5 py-1 text-xs transition ${
              triageOpen
                ? 'border-foreground bg-foreground text-background'
                : 'border-foreground/20 hover:border-foreground'
            }`}
          >
            Triage
            {unansweredHere.length > 0 && (
              <span
                className={`ml-1 ${triageOpen ? '' : 'text-amber-700 dark:text-amber-500'}`}
              >
                {unansweredHere.length}
              </span>
            )}
          </button>

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
          onDragOver={(e) => {
            if (dragging) e.preventDefault();
          }}
          onDrop={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();

            const codeId = e.dataTransfer.getData('text/code-id');
            const valueId = e.dataTransfer.getData('text/value-id');

            // A CODE on empty canvas is unfiled from this dimension and returns to the
            // staging box. Un-filing must be as cheap as filing, or a misdrop is a trap
            // you can only escape through the inspector.
            if (codeId) {
              const from =
                codes
                  .find((c) => c.id === codeId)
                  ?.facetValueIds.filter((id) => valueById.has(id)) ?? [];
              if (from.length > 0) {
                run(async () => {
                  for (const old of from) await removeCodeFacetValue(codeId, old);
                });
              }
            } else if (valueId && valueById.get(valueId)?.parent_id != null) {
              // A VALUE on empty canvas is promoted to the TOP LEVEL — its own tree,
              // carrying its whole sub-chain and every code answering it. This is the
              // inverse of dropping it onto a parent, and it must exist: realising that a
              // sub-answer is actually a peer answer is the commonest correction there
              // is, and without it the only escape from a bad nesting is delete-and-retype.
              //
              // It cannot cycle (null parent), so no guard is needed here.
              run(() => setFacetValueParent(valueId, null));
            }
            setDragging(null);
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
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/value-id', n.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging({ kind: 'value', id: n.id });
                    }}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => {
                      // Never a drop target for ITSELF; the server rejects a cycle anyway,
                      // but an affordance that always errors is a lie the UI is telling.
                      if (dragging && !(dragging.kind === 'value' && dragging.id === n.id)) {
                        e.preventDefault();
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const codeId = e.dataTransfer.getData('text/code-id');
                      const valueId = e.dataTransfer.getData('text/value-id');
                      if (codeId) {
                        // Dragging a code from ANOTHER value MOVES it: a drag reads as
                        // relocation, not accumulation. To make a code answer two values
                        // (the cross-cutting case) use the picker, which says so out loud.
                        const from = codes
                          .find((c) => c.id === codeId)
                          ?.facetValueIds.filter((id) => valueById.has(id)) ?? [];
                        run(async () => {
                          for (const old of from) {
                            if (old !== n.id) await removeCodeFacetValue(codeId, old);
                          }
                          await addCodeFacetValue(codeId, n.id);
                        });
                      } else if (valueId && valueId !== n.id) {
                        run(() => setFacetValueParent(valueId, n.id));
                      }
                      setDragging(null);
                    }}
                    className={`absolute -translate-x-1/2 ${
                      dragging && !(dragging.kind === 'value' && dragging.id === n.id)
                        ? 'rounded outline-dashed outline-1 outline-offset-4 outline-foreground/30'
                        : ''
                    }`}
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
                      {/* One click to grow a BRANCH. A sub-value is just a name, so
                          making you open a dialog and choose a tab to add one taxed the
                          cheapest move in the tool. */}
                      <button
                        type="button"
                        onClick={() => {
                          setQuickBranchAt(n.id);
                          setQuickBranchName('');
                        }}
                        className="shrink-0 text-xs leading-4 text-foreground/25 transition hover:text-foreground"
                        aria-label={`Add a sub-value under ${n.name}`}
                        title="Add a sub-value — just a name"
                      >
                        ⌄
                      </button>
                    </div>

                    {quickBranchAt === n.id && facet !== null && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const label = quickBranchName.trim();
                          if (!label) {
                            setQuickBranchAt(undefined);
                            return;
                          }
                          run(async () => {
                            await createFacetValue(facet.id, {
                              key: crypto.randomUUID(),
                              label,
                              parentId: n.id,
                            });
                            // Stay open, cleared: adding one branch usually means
                            // adding three, and re-clicking the ghost for each is the
                            // friction this exists to remove.
                            setQuickBranchName('');
                          });
                        }}
                        className="mt-1"
                      >
                        <input
                          autoFocus
                          value={quickBranchName}
                          onChange={(e) => setQuickBranchName(e.target.value)}
                          onBlur={() => setQuickBranchAt(undefined)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setQuickBranchAt(undefined);
                          }}
                          placeholder="sub-value…"
                          className="w-full border-b border-dashed border-foreground/40 bg-transparent px-1 text-center text-xs focus:border-solid focus:border-foreground focus:outline-none"
                        />
                      </form>
                    )}

                    {(bucket.direct.length > 0 || bucket.inherited.length > 0) && (
                      <div className="mt-1 flex flex-wrap justify-center gap-1">
                        {bucket.direct.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/code-id', c.id);
                              e.dataTransfer.effectAllowed = 'move';
                              setDragging({ kind: 'code', id: c.id });
                            }}
                            onDragEnd={() => setDragging(null)}
                            onClick={() => inspect({ kind: 'code', id: c.id })}
                            className={`max-w-full cursor-grab truncate border px-1.5 py-0.5 text-[10px] transition active:cursor-grabbing ${
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

        {facet !== null && (
          <StagingBox
            facetId={facet.id}
            facetLabel={facet.label}
            unfiled={unansweredHere}
            onDragCode={(id) => setDragging(id === null ? null : { kind: 'code', id })}
            onSelectCode={(id) => inspect({ kind: 'code', id })}
          />
        )}

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

      {/* ---------------- overlay window: inspect / triage ----------------------- */}
      {/* Not a rail. A permanent sidebar taxes the width of the canvas even when you are
          not reading anything — and the canvas IS the thinking surface. The panel appears
          when you click something and gets out of the way when you are done. It is
          non-modal (no backdrop): it floats over the canvas so you can still see the tree
          you are editing against, which a centred modal would hide behind itself. */}
      {(selected !== null || triageOpen) && (
        <div
          role="dialog"
          aria-label={triageOpen ? 'Triage' : 'Inspect'}
          className="absolute right-6 top-6 bottom-6 z-40 flex w-[26rem] flex-col border border-foreground/20 bg-background shadow-2xl"
        >
          <div className="flex items-center gap-2 border-b border-foreground/15 px-3 py-2">
            <span className="text-xs font-medium tracking-tight">
              {triageOpen
                ? `Triage · ${unansweredHere.length} unclassified`
                : selected?.kind === 'value'
                  ? 'Value'
                  : 'Code'}
            </span>
            <button
              type="button"
              onClick={() => {
                setTriageOpen(false);
                setSelected(null);
              }}
              className="ml-auto px-1 text-lg leading-none text-foreground/40 transition hover:text-foreground"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {triageOpen ? (
              <TriageQueue codes={codes} facets={dimensions} citations={citations} />
            ) : selected?.kind === 'value' ? (
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
                onRename={(label) => run(() => updateFacetValue(selected.id, { label }))}
                onZoom={() => setFocusId(selected.id)}
                onUnnest={
                  valueById.get(selected.id)?.parent_id == null
                    ? undefined
                    : () => run(() => setFacetValueParent(selected.id, null))
                }
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
            ) : selected !== null ? (
              // The inspector IS the editor. There is no "full anatomy →" link: a link out
              // says the panel is a preview of the real thing elsewhere, which makes the
              // panel pointless and the trip expensive — you lose the canvas, and with it
              // the reason you opened the code.
              <CodeEditor
                key={selected.id}
                code={codeById.get(selected.id)!}
                facets={dimensions}
                citations={citations}
                promoteTo={facet?.label ?? null}
                onPromote={
                  facet === null
                    ? undefined
                    : () =>
                        run(async () => {
                          await promoteCodeToValue(selected.id, facet.id, null);
                          setSelected(null);
                        })
                }
              />
            ) : null}
          </div>
        </div>
      )}

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
  onRename,
  onZoom,
  onUnnest,
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
  onRename: (label: string) => void;
  onZoom: () => void;
  /** Promote to the top level of this dimension. Absent when already a root. */
  onUnnest?: () => void;
  onInterpose: () => void;
  onDissolve: () => void;
  onDetach: (codeId: string) => void;
}) {
  const [description, setDescription] = useState(value.description ?? '');
  const [label, setLabel] = useState(value.label);
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
        {/* Editable in place. The label is what the whole canvas is drawn from, so a
            value you cannot rename is a naming decision you can only revise by deleting
            and retyping — and deleting takes its sub-chain and its codes with it. A blank
            reverts rather than saving: an unnamed value is unusable, not empty. */}
        <input
          value={label}
          disabled={pending}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            const next = label.trim();
            if (!next || next === value.label) {
              setLabel(value.label);
              return;
            }
            onRename(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setLabel(value.label);
              e.currentTarget.blur();
            }
          }}
          aria-label="Value name"
          className="w-full border-b border-dashed border-foreground/25 bg-transparent text-base font-medium tracking-tight focus:border-solid focus:border-foreground focus:outline-none"
        />
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
        {/* Same as dragging it onto empty canvas — but a drop target you cannot see is
            not an affordance. The gesture is faster once you know it; the button is what
            tells you it exists. */}
        {onUnnest && (
          <button
            type="button"
            onClick={onUnnest}
            disabled={pending}
            title="Promote to the top level of this dimension. Its sub-values and every code answering it come along."
            className="border border-foreground/20 px-2 py-1 text-xs transition enabled:hover:border-foreground disabled:opacity-40"
          >
            Make its own tree
          </button>
        )}
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

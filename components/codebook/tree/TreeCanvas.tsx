'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  attachCodeToLabel,
  deleteLabel,
  detachCodeFromLabel,
  interposeLabel,
  setLabelNote,
} from '@/app/actions/labels';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { buildLabelTree } from '@/lib/codebook/labelTree';
import { searchCodes } from '@/lib/codebook/codePicker';
import { ancestorsOf, layoutTree, subtreeAt } from '@/lib/codebook/treeLayout';
import FacetEditor from '@/components/matrix/FacetEditor';
import type { Tables } from '@/lib/types/cb-db';
import NewCodeDialog, { type DialogTarget } from './NewCodeDialog';

type Label = Tables<'cb_labels'>;
type Citation = Tables<'cb_citations'>;

// Slot units → pixels. The layout is font- and zoom-independent; only these two
// numbers turn it into a picture.
const COL = 190;
const ROW = 132;

type Selection = { kind: 'node'; id: string } | { kind: 'code'; id: string } | null;

/**
 * The codebook tree canvas.
 *
 * One surface for the whole instrument: the construct tree, the codes placed on
 * it, the scheme that defines a code, and the codes not yet placed anywhere.
 *
 * Two kinds of thing, never conflated:
 *   NODE — a construct/folder. Never applied to data. Carries a note.
 *   CODE — the only codeable thing. Carries the scheme. Rendered as a chip on the
 *          node it is placed at, NOT as a tree node of its own (a code is placed
 *          ON a node, and may be placed on several — so it has no single column).
 *
 * Interaction:
 *   click node/code  → inspect it in the side panel
 *   ⌘/Ctrl-click node → ZOOM into it. Ancestors stay visible above, dimmed but
 *                       CLICKABLE, so zooming never strands you with no way back.
 *   `+` on a node    → new child (code or node — the dialog asks)
 *   `+` in the header → new root
 */
export default function TreeCanvas({
  codebookId,
  labels,
  codes,
  facets,
  citations,
}: {
  codebookId: string;
  labels: Label[];
  codes: CodeWithRefs[];
  facets: FacetWithValues[];
  citations: Citation[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [interposeAt, setInterposeAt] = useState<string | null>(null);
  const [pinnedCitationId, setPinnedCitationId] = useState<string | null>(null);
  const [schemeOpen, setSchemeOpen] = useState(false);

  const forest = useMemo(() => buildLabelTree(labels), [labels]);

  // Codes placed on each node. DIRECT placements only — a parent must not claim a
  // count it inherits from its subtree (see treeLayout).
  const codesByLabel = useMemo(() => {
    const m = new Map<string, CodeWithRefs[]>();
    for (const c of codes) {
      for (const labelId of c.labelIds) {
        const bucket = m.get(labelId);
        if (bucket) bucket.push(c);
        else m.set(labelId, [c]);
      }
    }
    return m;
  }, [codes]);

  const countByLabel = useMemo(
    () => new Map([...codesByLabel].map(([k, v]) => [k, v.length])),
    [codesByLabel],
  );

  // Zero placements = never structured. This is the ad-hoc path: a code may exist
  // before it has a home, because structure is often impossible to impose up front.
  const unplaced = useMemo(() => codes.filter((c) => c.labelIds.length === 0), [codes]);

  // The rendered forest: the whole thing, or just the focused subtree.
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
    () => layoutTree(visibleRoots, countByLabel),
    [visibleRoots, countByLabel],
  );

  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const codeById = useMemo(() => new Map(codes.map((c) => [c.id, c])), [codes]);
  const nodeNameById = useMemo(
    () => new Map(labels.map((l) => [l.id, l.name])),
    [labels],
  );

  function run(fn: () => Promise<unknown>) {
    start(async () => {
      await fn();
      router.refresh();
    });
  }

  const x = (n: number) => n * COL + COL / 2;
  const y = (n: number) => n * ROW + 48;

  return (
    <main className="flex h-[calc(100vh-3.25rem)]">
      <section className="flex min-w-0 flex-1 flex-col">
        {/* ---------------- header: new root + the deductive paper pin ---------- */}
        <div className="flex items-center gap-4 border-b border-foreground/15 px-6 py-2.5">
          <button
            type="button"
            onClick={() => setDialog({ kind: 'root' })}
            className="border border-foreground px-2.5 py-1 text-xs transition hover:bg-foreground hover:text-background"
          >
            + New root
          </button>

          <label className="flex items-center gap-2 text-xs text-foreground/60">
            {/* The pin is the whole point of deductive mode: a codebook derived from
                a paper should not re-ask for that paper on every single code. */}
            <span className="text-foreground/80">Deductive — pin paper:</span>
            <select
              value={pinnedCitationId ?? ''}
              onChange={(e) => setPinnedCitationId(e.target.value || null)}
              className="border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
            >
              <option value="">off (no paper)</option>
              {citations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.bibtex_key ?? c.title ?? c.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>

          {pinnedCitationId !== null && (
            <span className="text-xs text-foreground/45">
              new codes auto-link this paper, and default to <em>a priori</em>
            </span>
          )}

          {/* The SCHEME is editable HERE, not on another page. The New Code dialog
              renders whatever facets are declared, so declaring a facet and using
              it must not be two destinations — otherwise the researcher discovers
              a missing field mid-authoring and has to abandon the code to go add
              it. Same FacetEditor the matrix uses; no second implementation. */}
          <button
            type="button"
            onClick={() => setSchemeOpen((s) => !s)}
            className="border border-foreground/20 px-2.5 py-1 text-xs transition hover:border-foreground"
            aria-expanded={schemeOpen}
          >
            {schemeOpen ? 'Hide scheme' : 'Edit scheme'}
            <span className="ml-1 text-foreground/40">({facets.length})</span>
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

        {/* ---------------- zoom trail: ancestors, dimmed but clickable --------- */}
        {focusId !== null && (
          <div className="flex items-center gap-1.5 border-b border-foreground/10 px-6 py-1.5 text-xs">
            <button
              type="button"
              onClick={() => setFocusId(null)}
              className="text-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
            >
              whole tree
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
            <span className="font-medium">{labelById.get(focusId)?.name}</span>
          </div>
        )}

        {/* ---------------- canvas ---------------------------------------------- */}
        <div className="relative flex-1 overflow-auto bg-foreground/[0.02] p-6">
          {/* The corner `+`: a code with NO home, saved for later. The whole point
              is that it costs nothing and interrupts nothing — an idea you have
              mid-thought should not first demand that you decide where it belongs.
              Deciding is the expensive part; deferring it is the feature.

              It offers only "new code": a floating code has no node to attach to,
              so "existing code" would be an attach with no target. */}
          <button
            type="button"
            onClick={() => setDialog({ kind: 'floating' })}
            title="New floating code — no home yet, file it later"
            aria-label="New floating code"
            className="fixed bottom-28 right-[22rem] z-30 flex h-11 w-11 items-center justify-center rounded-full border border-foreground/20 bg-background text-lg shadow-lg transition hover:border-foreground hover:bg-foreground hover:text-background"
          >
            +
          </button>

          {layout.nodes.length === 0 ? (
            <p className="mt-16 text-center text-sm text-foreground/45">
              No nodes yet. <strong>+ New root</strong> starts a tree — or add codes
              below and impose structure later.
            </p>
          ) : (
            <div
              className="relative"
              style={{
                width: Math.max(layout.width, 1) * COL,
                height: layout.height * ROW + 60,
              }}
            >
              {/* Edges first, so node cards paint over the lines. */}
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                aria-hidden
              >
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
                const placed = codesByLabel.get(n.id) ?? [];
                const isSel = selected?.kind === 'node' && selected.id === n.id;
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
                          // ⌘/Ctrl-click zooms; a plain click inspects. Same target,
                          // two intents — matches how people already treat links.
                          if (e.metaKey || e.ctrlKey) setFocusId(n.id);
                          else setSelected({ kind: 'node', id: n.id });
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
                        aria-label={`Add a child under ${n.name}`}
                        title="Add a child (code or node)"
                      >
                        +
                      </button>
                    </div>

                    {/* Codes placed HERE. Chips, not tree nodes — a code may be
                        placed on several nodes, so it has no column of its own. */}
                    {placed.length > 0 && (
                      <div className="mt-1 flex flex-wrap justify-center gap-1">
                        {placed.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setSelected({ kind: 'code', id: c.id })}
                            className={`max-w-full truncate border px-1.5 py-0.5 text-[10px] transition ${
                              selected?.kind === 'code' && selected.id === c.id
                                ? 'border-foreground bg-foreground text-background'
                                : 'border-foreground/25 text-foreground/70 hover:border-foreground'
                            }`}
                            title={c.name}
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

        {/* ---------------- unplaced tray --------------------------------------- */}
        <div className="border-t border-foreground/15 px-6 py-3">
          <div className="mb-1.5 flex items-baseline gap-2">
            <h2 className="text-xs font-medium tracking-tight">Unplaced</h2>
            <span className="text-xs text-foreground/45">
              {unplaced.length === 0
                ? 'every code sits somewhere in the tree'
                : `${unplaced.length} code${unplaced.length === 1 ? '' : 's'} with no home yet — select a node, then place`}
            </span>
          </div>
          {unplaced.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {unplaced.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={selected?.kind !== 'node' || pending}
                  onClick={() => {
                    if (selected?.kind !== 'node') return;
                    run(() => attachCodeToLabel(c.id, selected.id));
                  }}
                  title={
                    selected?.kind === 'node'
                      ? `Place ${c.mnemonic} under ${labelById.get(selected.id)?.name}`
                      : 'Select a node first'
                  }
                  className="border border-dashed border-foreground/30 px-1.5 py-0.5 text-[10px] text-foreground/70 transition enabled:hover:border-foreground enabled:hover:text-foreground disabled:opacity-50"
                >
                  {c.mnemonic}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ---------------- inspector ------------------------------------------- */}
      <aside className="w-80 shrink-0 overflow-y-auto border-l border-foreground/15 p-5">
        {selected === null ? (
          <p className="text-xs leading-relaxed text-foreground/45">
            Click a <strong>node</strong> to edit its note, or a <strong>code</strong>{' '}
            to see its scheme.
            <br />
            <br />
            A node is a grouping — it is never applied to data, so it has no scheme.
            A code is the only thing you ever apply.
          </p>
        ) : selected.kind === 'node' ? (
          <NodeInspector
            key={selected.id}
            node={labelById.get(selected.id)!}
            childNodes={(subtreeAt(forest, selected.id)?.children ?? []).map((c) => ({
              id: c.id,
              name: c.name,
            }))}
            placed={codesByLabel.get(selected.id) ?? []}
            allCodes={codes}
            nodeNameById={nodeNameById}
            pending={pending}
            onAttach={(codeId) => run(() => attachCodeToLabel(codeId, selected.id))}
            onSaveNote={(note) => run(() => setLabelNote(selected.id, note))}
            onZoom={() => setFocusId(selected.id)}
            onInterpose={() => setInterposeAt(selected.id)}
            onDissolve={() =>
              run(async () => {
                await deleteLabel(selected.id);
                setSelected(null);
                if (focusId === selected.id) setFocusId(null);
              })
            }
            onDetach={(codeId) => run(() => detachCodeFromLabel(codeId, selected.id))}
          />
        ) : (
          <CodeInspector
            code={codeById.get(selected.id)!}
            facets={facets}
            placements={(codeById.get(selected.id)?.labelIds ?? []).map(
              (id) => labelById.get(id)?.name ?? '—',
            )}
          />
        )}
      </aside>

      {dialog !== null && (
        <NewCodeDialog
          codebookId={codebookId}
          target={dialog}
          facets={facets}
          codes={codes}
          nodeNameById={nodeNameById}
          pinnedCitationId={pinnedCitationId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}

      {interposeAt !== null && (
        <InterposeDialog
          parent={labelById.get(interposeAt)!}
          candidates={(subtreeAt(forest, interposeAt)?.children ?? []).map((c) => ({
            id: c.id,
            name: c.name,
          }))}
          onClose={() => setInterposeAt(null)}
          onSubmit={(name, childIds) =>
            run(async () => {
              await interposeLabel(codebookId, { parentId: interposeAt, name, childIds });
              setInterposeAt(null);
            })
          }
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function NodeInspector({
  node,
  childNodes,
  placed,
  allCodes,
  nodeNameById,
  pending,
  onAttach,
  onSaveNote,
  onZoom,
  onInterpose,
  onDissolve,
  onDetach,
}: {
  node: Label;
  childNodes: { id: string; name: string }[];
  placed: CodeWithRefs[];
  /** EVERY code, not just the homeless ones — placing an already-placed code here
   *  is how a duplicate gets made, and duplicates are the point. */
  allCodes: CodeWithRefs[];
  nodeNameById: ReadonlyMap<string, string>;
  pending: boolean;
  onAttach: (codeId: string) => void;
  onSaveNote: (note: string) => void;
  onZoom: () => void;
  onInterpose: () => void;
  onDissolve: () => void;
  onDetach: (codeId: string) => void;
}) {
  const [note, setNote] = useState(node.note ?? '');
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);

  const hits = useMemo(
    () => (picking ? searchCodes(allCodes, query, node.id, nodeNameById) : []),
    [picking, allCodes, query, node.id, nodeNameById],
  );

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-foreground/40">Node</p>
        <h2 className="text-base font-medium tracking-tight">{node.name}</h2>
      </div>

      <div className="space-y-1">
        <label className="block text-xs font-medium text-foreground/80">Note</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (node.note ?? '') && onSaveNote(note)}
          rows={5}
          placeholder="Why does this grouping exist? What does it gather — and what does it deliberately NOT gather?"
          className="w-full border border-foreground/20 bg-background px-2 py-1.5 text-sm focus:border-foreground focus:outline-none"
        />
        <p className="text-xs text-foreground/40">
          A node is never applied to data, so it has no scheme — it carries a note.
          Saves on blur.
        </p>
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
          disabled={childNodes.length === 0}
          title={
            childNodes.length === 0
              ? 'Nothing to pull down — this node has no child nodes'
              : 'Insert an intermediary parent above some of these children'
          }
          className="border border-foreground/20 px-2 py-1 text-xs transition enabled:hover:border-foreground disabled:opacity-40"
        >
          Interpose…
        </button>
        <button
          type="button"
          onClick={onDissolve}
          disabled={pending}
          title="Delete this node; its children collapse up one level (the inverse of interpose). Codes are untouched."
          className="border border-foreground/20 px-2 py-1 text-xs text-foreground/60 transition hover:border-red-500 hover:text-red-600"
        >
          Dissolve
        </button>
      </div>

      {placed.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground/80">
            Codes placed here ({placed.length})
          </p>
          {placed.map((c) => (
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
                title="Remove from this node only. Other placements stay; the code is not deleted."
                className="shrink-0 text-foreground/40 hover:text-red-600"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---- place an EXISTING code here: the affordance that makes duplicates
           reachable. A tray of only-unplaced codes can never produce a second
           placement, so the data model would allow duplicates while the interface
           quietly forbade them. This searches ALL codes. ---- */}
      <div className="space-y-1.5 border-t border-foreground/10 pt-3">
        {!picking ? (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="w-full border border-dashed border-foreground/30 px-2 py-1.5 text-xs text-foreground/60 transition hover:border-foreground hover:text-foreground"
          >
            + Place an existing code here
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
                  title={
                    h.status === 'here'
                      ? 'Already placed on this node.'
                      : h.status === 'elsewhere'
                        ? `Also sits under ${h.otherNodes.join(', ')} — placing it here makes a DUPLICATE (deliberate, but say so out loud).`
                        : 'Currently unplaced — this files it.'
                  }
                  className={`w-full border px-1.5 py-1 text-left text-xs transition ${
                    h.status === 'here'
                      ? 'cursor-default border-transparent text-foreground/30'
                      : 'border-transparent hover:border-foreground/30 hover:bg-foreground/[0.03]'
                  }`}
                >
                  <span className="font-mono">{h.mnemonic}</span>{' '}
                  <span className="text-foreground/60">{h.name}</span>
                  {h.status === 'here' && (
                    <span className="ml-1 text-foreground/30">· already here</span>
                  )}
                  {h.status === 'elsewhere' && (
                    // Naming the other nodes is the whole safeguard: a duplicate
                    // should be a decision you can see yourself making.
                    <span className="ml-1 text-amber-700 dark:text-amber-500">
                      · duplicate of {h.otherNodes.join(', ')}
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
  placements,
}: {
  code: CodeWithRefs;
  facets: FacetWithValues[];
  placements: string[];
}) {
  // Which enum value this code carries on each facet — the scheme, read back.
  const valueLabel = (f: FacetWithValues) =>
    f.values.find((v) => code.facetValueIds.includes(v.id))?.label ?? null;

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

      <div className="space-y-1">
        <p className="text-xs font-medium text-foreground/80">Scheme</p>
        {facets.length === 0 ? (
          <p className="text-xs text-foreground/45 italic">No facets declared.</p>
        ) : (
          facets.map((f) => {
            const field = code.facetFields.find((x) => x.facetId === f.id);
            const shown =
              f.type === 'enum'
                ? valueLabel(f)
                : f.type === 'boolean'
                  ? field?.boolValue
                    ? 'yes'
                    : null
                  : (field?.textValue ?? null);
            return (
              <div key={f.id} className="flex justify-between gap-3 text-xs">
                <span className="text-foreground/55">{f.label}</span>
                <span className={shown ? '' : 'text-foreground/30'}>{shown ?? '—'}</span>
              </div>
            );
          })
        )}
      </div>

      <div>
        <p className="text-xs font-medium text-foreground/80">
          Placed at ({placements.length})
        </p>
        {placements.length === 0 ? (
          <p className="mt-0.5 text-xs text-foreground/45 italic">
            Unplaced — it exists, but has no home in the tree yet.
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-foreground/60">{placements.join(' · ')}</p>
        )}
        {placements.length > 1 && (
          <p className="mt-1 text-xs leading-snug text-foreground/40">
            This code sits in more than one branch. That is allowed on purpose — but
            it means the tree is not a partition, so per-branch counts do not sum to
            the number of codes.
          </p>
        )}
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
  parent,
  candidates,
  onClose,
  onSubmit,
}: {
  parent: Label;
  /** The parent's current child NODES — the only things interpose may capture.
   *  Named `candidates`, not `children`: a prop called `children` shadows React's
   *  own and would be read as slot content rather than data. */
  candidates: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (name: string, childIds: string[]) => void;
}) {
  const [name, setName] = useState('');
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
            Interpose a node under {parent.name}
          </h2>
          <p className="mt-0.5 text-xs text-foreground/50">
            Too granular? Pull some of these children down under a new intermediary
            parent. No code is touched.
          </p>
        </div>

        <div className="space-y-3 px-4 py-4">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name of the new intermediary node"
            className="w-full border border-foreground/20 bg-background px-2 py-1.5 text-sm focus:border-foreground focus:outline-none"
          />
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground/80">
              Children to pull down
            </p>
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
              Unselected children stay where they are.
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
            onClick={() => onSubmit(name, picked)}
            disabled={!name.trim() || picked.length === 0}
            className="border border-foreground bg-foreground px-4 py-1.5 text-sm text-background transition hover:opacity-90 disabled:opacity-40"
          >
            Interpose
          </button>
        </div>
      </div>
    </div>
  );
}

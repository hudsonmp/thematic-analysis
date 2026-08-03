'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useMemo, useRef, useState } from 'react';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { splitDefinition } from '@/lib/codebook/definition';
import NoteText from '@/components/codebook/NoteText';
import { setCodeNotes } from '@/app/actions/codes';
import {
  buildCodebookDocument,
  docNodesInOrder,
  type DocNode,
} from '@/lib/codebook/document';
import {
  computeSheetColumns,
  SHEET_COL_HEADERS,
  type SheetColKey,
} from '@/lib/codebook/sheet';
import type { Tables } from '@/lib/types/cb-db';

type Citation = Tables<'cb_citations'>;

/**
 * The codebook document renderer: a COVER PAGE (the organizing dimension's tree,
 * for orientation) followed by a SPREADSHEET — one bordered row per code, grouped
 * under full-width value rows. Landscape by construction (`@page` below): the
 * column set doesn't fit portrait, and a codebook consulted mid-coding is a
 * lookup table, not prose — row/column scanning beats reading.
 *
 * COLUMNS SIZE THEMSELVES TO THE DATA. A fixed colgroup starves whichever field
 * this particular codebook actually leans on (one instrument is exemplar-heavy,
 * another lives in include/exclude rules), so widths are computed per render:
 * columns empty across every code are DROPPED, and the rest share the width
 * proportional to sqrt(mean content length) — sqrt so one verbose outlier can't
 * flatten its neighbors (see `computeSheetColumns` in lib/codebook/sheet).
 *
 * "Export as PDF" is `window.print()` against this same HTML — NOT a server PDF
 * library. The browser already lays out this table (and repeats <thead> on every
 * printed page natively); a PDF lib would be a dependency, a second rendering
 * engine to keep in sync, and a worse result. The `print:` utilities strip the
 * chrome so the printed artifact is cover + table alone.
 */

type ColKey = SheetColKey;

/** Per-code cell text, flattened to plain strings for both width estimation and
 *  emptiness checks. `showLit` folds the literature half into the definition's
 *  measure only when it will actually render. */
function cellText(
  code: CodeWithRefs,
  showLit: boolean,
  answersFor: (c: CodeWithRefs) => string[],
  citesFor: (c: CodeWithRefs) => string[],
): Record<ColKey, string> {
  const v = code.current;
  const def = splitDefinition(v?.definition);
  return {
    code: code.mnemonic,
    definition:
      (showLit && def.literature !== null ? `${def.literature} ` : '') + def.applied,
    // Only the SHORTEST exemplar renders (see CodeRow), so measure only it — else
    // the exemplar column is sized for text that never appears.
    exemplars: shortestExemplar(asExemplarText(v?.exemplars)) ?? '',
    counter: v?.disconfirming_pattern ?? '',
    notes: code.notes ?? '',
    meta: [...answersFor(code), ...citesFor(code)].join(' '),
  };
}

export default function CodebookViewDocument({
  codebookName,
  codebookId,
  codebooks,
  facets,
  codes,
  citations,
  canEdit = false,
}: {
  codebookName: string;
  codebookId: string;
  /** All of the study's codebooks — the view-only picker. Selecting one swaps
   *  the URL's ?codebook= (this page reloads with that instrument), NOT the
   *  active-codebook cookie: printing B must not redirect future coding to B. */
  codebooks: { id: string; name: string }[];
  facets: FacetWithValues[];
  codes: CodeWithRefs[];
  citations: Citation[];
  /** Editors may click a Notes cell to edit in place; viewers read only. */
  canEdit?: boolean;
}) {
  const router = useRouter();
  const enumFacets = useMemo(() => facets.filter((f) => f.type === 'enum'), [facets]);
  const [organizingId, setOrganizingId] = useState<string | undefined>(undefined);
  // Literature halves of 'Literature == Applied' definitions are provenance —
  // useful when reviewing the instrument, noise when printing a working lookup
  // sheet. OFF by default; the toggle is a print decision, so it lives with
  // Export PDF in the toolbar.
  const [showLit, setShowLit] = useState(false);

  const doc = useMemo(
    () => buildCodebookDocument(facets, codes, organizingId),
    [facets, codes, organizingId],
  );

  // Value label + facet label for a code's answers, looked up across ALL dimensions.
  const valueLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of enumFacets) for (const v of f.values) m.set(v.id, v.label);
    return m;
  }, [enumFacets]);
  const citationLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of citations) m.set(c.id, c.bibtex_key ?? c.title ?? c.id.slice(0, 8));
    return m;
  }, [citations]);

  if (doc === null) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-sm text-foreground/50">
        No dimensions defined yet — there is nothing to organize a document by. Declare a
        facet on the codebook page first.
      </main>
    );
  }

  const nodes = docNodesInOrder(doc.roots);

  const answersFor = (code: CodeWithRefs) =>
    enumFacets
      .map((f) => {
        const vals = f.values
          .filter((x) => code.facetValueIds.includes(x.id))
          .map((x) => valueLabel.get(x.id) ?? x.label);
        return vals.length ? `${f.label}: ${vals.join(', ')}` : null;
      })
      .filter((x): x is string => x !== null);
  const citesFor = (code: CodeWithRefs) =>
    code.citationIds.map((cid) => citationLabel.get(cid) ?? cid).filter(Boolean);

  // Distinct codes (cross-listed ones once) drive the width estimate; the same
  // extractor drives the cells, so measure and render can't drift.
  const distinct = new Map<string, CodeWithRefs>();
  for (const n of nodes) for (const c of n.codes) distinct.set(c.id, c);
  for (const c of doc.unfiled) distinct.set(c.id, c);
  const measureRows = [...distinct.values()].map((c) =>
    cellText(c, showLit, answersFor, citesFor),
  );
  const cols = computeSheetColumns(measureRows);
  const colKeys = cols.map((c) => c.key);

  return (
    <main
      lang="en"
      className="cb-sheet mx-auto max-w-[1400px] px-6 py-8 print:max-w-none print:px-0 print:py-0"
    >
      {/* The printed artifact is landscape — the column set is unreadable in
          portrait. Scoped to this route by mounting: the rules exist only while
          this document is on screen, so other pages' print output is untouched.
          The tr rules are the "no code on two pages" guarantee: both the modern
          and legacy property, on the ROW, because Chrome's print pipeline has
          historically honored one or the other depending on version. */}
      <style>{`
        @page { size: letter landscape; margin: 0.4in 0.15in; }
        /* A token wider than its fixed column must not overflow the grid. Two
           rules together: hyphens:auto inserts a real hyphen where the word has a
           valid break point (needs lang, set on <main>); overflow-wrap:anywhere
           guarantees any remaining long token still breaks. On screen AND in print. */
        .cb-sheet td, .cb-sheet th {
          overflow-wrap: anywhere;
          hyphens: auto;
          -webkit-hyphens: auto;
        }
        @media print {
          .cb-sheet tbody tr { break-inside: avoid; page-break-inside: avoid; }
          .cb-sheet section { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      {/* Toolbar — stripped from the printed page. */}
      <div className="mb-6 flex items-center gap-4 print:hidden">
        {codebooks.length > 1 && (
          <label className="flex items-center gap-2 text-xs">
            <span className="text-foreground/60">Codebook</span>
            <select
              value={codebookId}
              onChange={(e) => router.replace(`/codebook/view?codebook=${e.target.value}`)}
              className="border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
            >
              {codebooks.map((cb) => (
                <option key={cb.id} value={cb.id}>
                  {cb.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-xs">
          <span className="text-foreground/60">Organize by</span>
          <select
            value={doc.organizingFacet.id}
            onChange={(e) => setOrganizingId(e.target.value)}
            className="border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
          >
            {enumFacets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground/60">
          <input
            type="checkbox"
            checked={showLit}
            onChange={(e) => setShowLit(e.target.checked)}
            className="accent-foreground"
          />
          Literature definitions
        </label>
        <button
          type="button"
          onClick={() => {
            // The save dialog's suggested filename comes from document.title.
            // Suggest a clean, DOT-FREE name: a typed name like "1.1" makes
            // macOS treat ".1" as the extension, so no .pdf is appended and
            // the file looks broken (twice-observed failure). Dashes only.
            const prev = document.title;
            const stamp = new Date().toISOString().slice(0, 10);
            document.title = `codebook-${codebookName}-${stamp}`
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, '-')
              .replace(/-+/g, '-');
            window.print();
            document.title = prev;
          }}
          className="ml-auto border border-foreground px-3 py-1 text-xs text-foreground transition hover:bg-foreground hover:text-background"
        >
          Export PDF
        </button>
      </div>

      {/* COVER PAGE: title + the tree render of the organizing dimension, then a
          hard page break. The tree is the map the table is then read against —
          structure first, anatomy second. */}
      <section className="break-after-page mb-10 border-b border-foreground/20 pb-8 print:mb-0 print:border-b-0 print:pb-0">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">{codebookName}</h1>
          <p className="mt-1 text-sm text-foreground/50">
            Codebook · {doc.codeCount} code{doc.codeCount === 1 ? '' : 's'} · organized by{' '}
            {doc.organizingFacet.label}
          </p>
        </header>
        <div className="space-y-2">
          {nodes.map((node) => (
            <CoverTreeNode key={node.value.id} node={node} />
          ))}
          {doc.unfiled.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-foreground/70">
                Unfiled
                <span className="ml-2 text-xs font-normal text-foreground/40">
                  {doc.unfiled.length} · no answer on {doc.organizingFacet.label}
                </span>
              </p>
              <p className="ml-4 mt-0.5 font-mono text-xs leading-relaxed text-foreground/80">
                {doc.unfiled.map((c) => c.mnemonic).join('   ')}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* THE SPREADSHEET. Full grid borders (a lookup table earns them), value
          groups as full-width rows, <thead> repeats per printed page natively. */}
      <table className="w-full table-fixed border-collapse text-[11px] leading-snug">
        <colgroup>
          {cols.map((c) => (
            <col key={c.key} style={{ width: `${c.width}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b-2 border-foreground/40 text-left text-[10px] uppercase tracking-wide text-foreground/60">
            {cols.map((c) => (
              <Th key={c.key}>{SHEET_COL_HEADERS[c.key]}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <Fragment key={node.value.id}>
              <GroupRow node={node} span={cols.length} />
              {node.codes.map((c) => (
                <CodeRow
                  key={`${node.value.id}:${c.id}`}
                  code={c}
                  colKeys={colKeys}
                  showLit={showLit}
                  answersFor={answersFor}
                  citesFor={citesFor}
                  canEdit={canEdit}
                />
              ))}
            </Fragment>
          ))}
          {doc.unfiled.length > 0 && (
            <>
              <tr className="break-inside-avoid border border-foreground/15 bg-foreground/[0.05]">
                <td colSpan={cols.length} className="px-2 py-1 text-xs font-semibold">
                  Unfiled
                  <span className="ml-2 font-normal text-foreground/40">
                    no answer on {doc.organizingFacet.label}
                  </span>
                </td>
              </tr>
              {doc.unfiled.map((c) => (
                <CodeRow
                  key={c.id}
                  code={c}
                  colKeys={colKeys}
                  showLit={showLit}
                  answersFor={answersFor}
                  citesFor={citesFor}
                  canEdit={canEdit}
                />
              ))}
            </>
          )}
        </tbody>
      </table>
    </main>
  );
}

/** One line of the cover tree: the value at its depth, its codes as a slug run. */
function CoverTreeNode({ node }: { node: DocNode }) {
  const level = Math.min(node.depth, 3);
  const size = ['text-base', 'text-sm', 'text-sm', 'text-xs'][level];
  return (
    <div style={{ marginLeft: node.depth * 20 }}>
      <p className={`${size} font-semibold tracking-tight`}>
        {node.depth > 0 && <span className="mr-1 text-foreground/30">└</span>}
        {node.value.label}
        {node.codes.length > 0 && (
          <span className="ml-2 text-xs font-normal text-foreground/40">
            {node.codes.length}
          </span>
        )}
      </p>
      {node.codes.length > 0 && (
        <p className="ml-4 mt-0.5 font-mono text-xs leading-relaxed text-foreground/80">
          {node.codes.map((c) => c.mnemonic).join('   ')}
        </p>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="border border-foreground/15 px-2 py-1 font-semibold">{children}</th>;
}

/** Full-width value row — the section header inside the grid, indented by depth. */
function GroupRow({ node, span }: { node: DocNode; span: number }) {
  return (
    <tr className="break-inside-avoid border border-foreground/15 bg-foreground/[0.05]">
      <td colSpan={span} className="px-2 py-1">
        <span
          style={{ paddingLeft: node.depth * 16 }}
          className="text-xs font-semibold tracking-tight"
        >
          {node.value.label}
          {node.codes.length > 0 && (
            <span className="ml-2 font-normal text-foreground/40">{node.codes.length}</span>
          )}
        </span>
        {node.value.description && (
          <span className="ml-3 text-[10px] italic text-foreground/50">
            {node.value.description}
          </span>
        )}
      </td>
    </tr>
  );
}

function CodeRow({
  code,
  colKeys,
  showLit,
  answersFor,
  citesFor,
  canEdit,
}: {
  code: CodeWithRefs;
  colKeys: ColKey[];
  showLit: boolean;
  answersFor: (c: CodeWithRefs) => string[];
  citesFor: (c: CodeWithRefs) => string[];
  canEdit: boolean;
}) {
  const v = code.current;
  const def = splitDefinition(v?.definition);
  const exemplars = asExemplarText(v?.exemplars);

  const cell = (key: ColKey): React.ReactNode => {
    switch (key) {
      case 'code':
        return (
          <>
            <span className="break-words font-mono text-xs font-medium">
              {code.mnemonic}
            </span>
            <span className="mt-0.5 block text-[9px] uppercase tracking-wide text-foreground/40">
              {code.origin.replace('_', ' ')}
            </span>
          </>
        );
      case 'definition':
        return (
          <>
            {showLit && def.literature !== null && (
              <p className="mb-1 italic text-foreground/60">
                <span className="mr-1 not-italic text-[9px] uppercase tracking-wide text-foreground/40">
                  Lit
                </span>
                {def.literature}
              </p>
            )}
            {def.applied !== '' && <p>{def.applied}</p>}
          </>
        );
      case 'exemplars': {
        // One exemplar only — the SHORTEST. A codebook consulted mid-coding wants
        // the tightest anchor that still shows the pattern, not an exhaustive list.
        const ex = shortestExemplar(exemplars);
        return ex ? (
          <p className="italic text-foreground/75">&ldquo;{ex}&rdquo;</p>
        ) : null;
      }
      case 'counter':
        return v?.disconfirming_pattern ?? null;
      case 'notes':
        return <NotesCell codeId={code.id} notes={code.notes} canEdit={canEdit} />;
      case 'meta': {
        const answers = answersFor(code);
        const cites = citesFor(code);
        return (
          <>
            {answers.length > 0 && (
              <p className="text-foreground/70">{answers.join(' · ')}</p>
            )}
            {cites.length > 0 && (
              <p className="mt-0.5 text-foreground/50">{cites.join(', ')}</p>
            )}
          </>
        );
      }
    }
  };

  return (
    <tr className="break-inside-avoid border border-foreground/15 align-top">
      {colKeys.map((k) => (
        <Td key={k}>{cell(k)}</Td>
      ))}
    </tr>
  );
}

/**
 * The Notes cell — the document's WRITE-IN margin, editable in place (v: click,
 * type, blur saves; Esc cancels). Structure is plain-text syntax NoteText
 * renders: `1.` numbered steps, `a.` fork branches beneath one, `@slug` links.
 * The editing chrome never prints: the textarea exists only while focused, and
 * the empty-cell hint is print-hidden.
 */
function NotesCell({
  codeId,
  notes,
  canEdit,
}: {
  codeId: string;
  notes: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Esc = CANCEL for THIS edit only. The flag is reset on every open — a
  // sticky flag silently swallowed the NEXT edit's save (the "typed it all,
  // nothing saved" bug). The value itself is read from the DOM at blur, never
  // tracked in state: uncontrolled input + read-at-commit has no stale-closure
  // failure mode.
  const cancelledRef = useRef(false);

  if (editing) {
    return (
      <textarea
        autoFocus
        defaultValue={notes ?? ''}
        rows={Math.max(4, (notes ?? '').split('\n').length + 1)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            cancelledRef.current = true;
            setEditing(false);
          } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.currentTarget.blur(); // ⌘⏎ commits via the same blur path
          }
        }}
        onBlur={(e) => {
          if (cancelledRef.current) {
            cancelledRef.current = false;
            return;
          }
          const next = e.currentTarget.value;
          setEditing(false);
          if (next === (notes ?? '')) return;
          setCodeNotes(codeId, next)
            .then(() => router.refresh())
            .catch((err) => setError(err instanceof Error ? err.message : 'Save failed.'));
        }}
        placeholder={'1. first step\na. fork branch\nb. other branch\n@slug links a code'}
        className="w-full border border-foreground/30 bg-background px-1 py-0.5 text-[11px] leading-snug focus:border-foreground focus:outline-none"
        aria-label="Notes"
      />
    );
  }

  return (
    <div
      onClick={
        canEdit
          ? () => {
              cancelledRef.current = false; // a past Esc must not eat this edit
              setError(null);
              setEditing(true);
            }
          : undefined
      }
      title={canEdit ? 'Click to edit — 1. numbered · a. fork branches · @slug links' : undefined}
      className={canEdit ? 'min-h-[1.5rem] cursor-text' : undefined}
    >
      {notes ? (
        <NoteText text={notes} />
      ) : canEdit ? (
        <span className="text-foreground/25 print:hidden">add notes…</span>
      ) : null}
      {error && <p className="text-[10px] text-red-600 print:hidden">{error}</p>}
    </div>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="border border-foreground/15 px-2 py-1.5 align-top">{children}</td>;
}


function asExemplarText(j: unknown): string[] {
  if (!Array.isArray(j)) return [];
  return j
    .map((raw) => (raw as { text?: unknown })?.text)
    .filter((t): t is string => typeof t === 'string');
}
/** The shortest exemplar by character length (first one wins ties, so it is
 *  deterministic). null when there are none. */
function shortestExemplar(items: string[]): string | null {
  if (items.length === 0) return null;
  return items.reduce((a, b) => (b.length < a.length ? b : a));
}

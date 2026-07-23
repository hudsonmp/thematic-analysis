'use client';

import { Fragment, useMemo, useState } from 'react';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { splitDefinition } from '@/lib/codebook/definition';
import {
  buildCodebookDocument,
  docNodesInOrder,
  type DocNode,
} from '@/lib/codebook/document';
import type { Tables } from '@/lib/types/cb-db';

type Citation = Tables<'cb_citations'>;

/**
 * The codebook document renderer: a COVER PAGE (the organizing dimension's tree,
 * for orientation) followed by a SPREADSHEET — one bordered row per code, grouped
 * under full-width value rows. Landscape by construction (`@page` below): seven
 * columns of code anatomy don't fit portrait, and a codebook consulted mid-coding
 * is a lookup table, not prose — row/column scanning beats reading.
 *
 * "Export as PDF" is `window.print()` against this same HTML — NOT a server PDF
 * library. The browser already lays out this table (and repeats <thead> on every
 * printed page natively); a PDF lib would be a dependency, a second rendering
 * engine to keep in sync, and a worse result. The `print:` utilities strip the
 * chrome so the printed artifact is cover + table alone.
 */
export default function CodebookViewDocument({
  codebookName,
  facets,
  codes,
  citations,
}: {
  codebookName: string;
  facets: FacetWithValues[];
  codes: CodeWithRefs[];
  citations: Citation[];
}) {
  const enumFacets = useMemo(() => facets.filter((f) => f.type === 'enum'), [facets]);
  const [organizingId, setOrganizingId] = useState<string | undefined>(undefined);

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

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-8 print:max-w-none print:px-0 print:py-0">
      {/* The printed artifact is landscape — a seven-column table is unreadable in
          portrait. Scoped to this route by mounting: the rule exists only while
          this document is on screen, so other pages' print output is untouched. */}
      <style>{`@page { size: letter landscape; margin: 0.5in; }`}</style>

      {/* Toolbar — stripped from the printed page. */}
      <div className="mb-6 flex items-center gap-3 print:hidden">
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
        <button
          type="button"
          onClick={() => window.print()}
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
          <col className="w-[13%]" />
          <col className="w-[24%]" />
          <col className="w-[13%]" />
          <col className="w-[13%]" />
          <col className="w-[18%]" />
          <col className="w-[11%]" />
          <col className="w-[8%]" />
        </colgroup>
        <thead>
          <tr className="border-b-2 border-foreground/40 text-left text-[10px] uppercase tracking-wide text-foreground/60">
            <Th>Code</Th>
            <Th>Definition</Th>
            <Th>Include if</Th>
            <Th>Exclude if</Th>
            <Th>Exemplars</Th>
            <Th>Counter-example</Th>
            <Th>Answers · Sources</Th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <Fragment key={node.value.id}>
              <GroupRow node={node} />
              {node.codes.map((c) => (
                <CodeRow
                  key={`${node.value.id}:${c.id}`}
                  code={c}
                  valueLabel={valueLabel}
                  citationLabel={citationLabel}
                  enumFacets={enumFacets}
                />
              ))}
            </Fragment>
          ))}
          {doc.unfiled.length > 0 && (
            <>
              <tr className="break-inside-avoid border border-foreground/15 bg-foreground/[0.05]">
                <td colSpan={7} className="px-2 py-1 text-xs font-semibold">
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
                  valueLabel={valueLabel}
                  citationLabel={citationLabel}
                  enumFacets={enumFacets}
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
function GroupRow({ node }: { node: DocNode }) {
  return (
    <tr className="break-inside-avoid border border-foreground/15 bg-foreground/[0.05]">
      <td colSpan={7} className="px-2 py-1">
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
  valueLabel,
  citationLabel,
  enumFacets,
}: {
  code: CodeWithRefs;
  valueLabel: Map<string, string>;
  citationLabel: Map<string, string>;
  enumFacets: FacetWithValues[];
}) {
  const v = code.current;
  // The codebook document shows BOTH halves of a 'Literature == Applied'
  // definition, labeled — this is the surface where provenance matters.
  const def = splitDefinition(v?.definition);
  const includeIf = asStrings(v?.include_if);
  const excludeIf = asStrings(v?.exclude_if);
  const exemplars = asExemplarText(v?.exemplars);
  const answers = enumFacets
    .map((f) => {
      const vals = f.values
        .filter((x) => code.facetValueIds.includes(x.id))
        .map((x) => valueLabel.get(x.id) ?? x.label);
      return vals.length ? `${f.label}: ${vals.join(', ')}` : null;
    })
    .filter((x): x is string => x !== null);
  const cites = code.citationIds.map((id) => citationLabel.get(id) ?? id).filter(Boolean);

  return (
    <tr className="break-inside-avoid border border-foreground/15 align-top">
      <Td>
        <span className="break-words font-mono text-xs font-medium">{code.mnemonic}</span>
        <span className="mt-0.5 block text-[9px] uppercase tracking-wide text-foreground/40">
          {code.origin.replace('_', ' ')}
        </span>
      </Td>
      <Td>
        {def.literature !== null && (
          <p className="mb-1 italic text-foreground/60">
            <span className="mr-1 not-italic text-[9px] uppercase tracking-wide text-foreground/40">
              Lit
            </span>
            {def.literature}
          </p>
        )}
        {def.applied !== '' && <p>{def.applied}</p>}
      </Td>
      <Td>
        <CellList items={includeIf} />
      </Td>
      <Td>
        <CellList items={excludeIf} />
      </Td>
      <Td>
        {exemplars.length > 0 && (
          <ul className="space-y-1">
            {exemplars.map((ex, i) => (
              <li key={i} className="italic text-foreground/75">
                &ldquo;{ex}&rdquo;
              </li>
            ))}
          </ul>
        )}
      </Td>
      <Td>{v?.disconfirming_pattern ?? null}</Td>
      <Td>
        {answers.length > 0 && <p className="text-foreground/70">{answers.join(' · ')}</p>}
        {cites.length > 0 && (
          <p className="mt-0.5 text-foreground/50">{cites.join(', ')}</p>
        )}
      </Td>
    </tr>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="border border-foreground/15 px-2 py-1.5 align-top">{children}</td>;
}

function CellList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="list-disc space-y-0.5 pl-3.5">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

/** Versioned columns round-trip through Json, so they arrive as `unknown`. */
function asStrings(j: unknown): string[] {
  return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
}
function asExemplarText(j: unknown): string[] {
  if (!Array.isArray(j)) return [];
  return j
    .map((raw) => (raw as { text?: unknown })?.text)
    .filter((t): t is string => typeof t === 'string');
}

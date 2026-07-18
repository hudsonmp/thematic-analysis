'use client';

import { useMemo, useState } from 'react';
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
 * The codebook document renderer. Nested list of every code with full anatomy,
 * organized by a chosen dimension, printable to PDF.
 *
 * "Export as PDF" is `window.print()` against a print stylesheet — NOT a server PDF
 * library. The browser already lays out this HTML perfectly; a PDF lib would be a
 * dependency, a second rendering engine to keep in sync, and a worse result. The
 * `print:` utilities strip the chrome (the toolbar, the app nav) so the printed page
 * is the document alone.
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
    <main className="mx-auto max-w-3xl px-6 py-8">
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

      {/* Document header. */}
      <header className="mb-8 border-b border-foreground/20 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">{codebookName}</h1>
        <p className="mt-1 text-sm text-foreground/50">
          Codebook · {doc.codeCount} code{doc.codeCount === 1 ? '' : 's'} · organized by{' '}
          {doc.organizingFacet.label}
        </p>
      </header>

      <div className="space-y-6">
        {nodes.map((node) => (
          <ValueSection
            key={node.value.id}
            node={node}
            valueLabel={valueLabel}
            citationLabel={citationLabel}
            enumFacets={enumFacets}
          />
        ))}

        {doc.unfiled.length > 0 && (
          <section>
            <h2 className="mb-1 border-b border-foreground/15 pb-0.5 text-sm font-semibold text-foreground/70">
              Unfiled
              <span className="ml-2 font-normal text-foreground/40">
                no answer on {doc.organizingFacet.label}
              </span>
            </h2>
            <div className="space-y-4 pt-2">
              {doc.unfiled.map((c) => (
                <CodeEntry
                  key={c.id}
                  code={c}
                  valueLabel={valueLabel}
                  citationLabel={citationLabel}
                  enumFacets={enumFacets}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function ValueSection({
  node,
  valueLabel,
  citationLabel,
  enumFacets,
}: {
  node: DocNode;
  valueLabel: Map<string, string>;
  citationLabel: Map<string, string>;
  enumFacets: FacetWithValues[];
}) {
  // Indent by depth so the nesting is visible on the page and in print. Headings scale
  // down one step per level, bottoming out so deep chains stay legible.
  const level = Math.min(node.depth, 3);
  const size = ['text-lg', 'text-base', 'text-sm', 'text-sm'][level];
  return (
    <section style={{ marginLeft: node.depth * 16 }} className="break-inside-avoid-page">
      <h2
        className={`${size} border-b border-foreground/15 pb-0.5 font-semibold tracking-tight`}
      >
        {node.value.label}
        {node.codes.length > 0 && (
          <span className="ml-2 text-xs font-normal text-foreground/40">
            {node.codes.length}
          </span>
        )}
      </h2>
      {node.value.description && (
        <p className="mt-1 text-xs italic text-foreground/50">{node.value.description}</p>
      )}
      {node.codes.length > 0 && (
        <div className="space-y-4 pt-2">
          {node.codes.map((c) => (
            <CodeEntry
              key={c.id}
              code={c}
              valueLabel={valueLabel}
              citationLabel={citationLabel}
              enumFacets={enumFacets}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CodeEntry({
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
    <article className="break-inside-avoid-page border-l-2 border-foreground/15 pl-3">
      <p className="text-sm">
        <span className="font-mono font-medium">{code.mnemonic}</span>
        <span className="ml-2 text-[11px] uppercase tracking-wide text-foreground/40">
          {code.origin.replace('_', ' ')}
        </span>
      </p>

      {def.literature !== null && (
        <div className="mt-0.5 text-xs italic leading-relaxed text-foreground/50">
          <span className="not-italic text-[10px] uppercase tracking-wide text-foreground/40">
            Literature
          </span>{' '}
          {def.literature}
        </div>
      )}
      {def.applied !== '' && (
        <p className="mt-0.5 text-sm leading-relaxed text-foreground/75">{def.applied}</p>
      )}

      <dl className="mt-1 space-y-0.5 text-xs text-foreground/70">
        {includeIf.length > 0 && <MetaList term="Include if" items={includeIf} />}
        {excludeIf.length > 0 && <MetaList term="Exclude if" items={excludeIf} />}
        {exemplars.length > 0 && <MetaList term="Exemplars" items={exemplars} />}
        {v?.disconfirming_pattern && (
          <MetaLine term="Counter-example" value={v.disconfirming_pattern} />
        )}
        {v?.prediction && <MetaLine term="Prediction" value={v.prediction} />}
        {v?.prediction_falsifier && (
          <MetaLine term="…falsified by" value={v.prediction_falsifier} />
        )}
        {answers.length > 0 && <MetaLine term="Answers" value={answers.join(' · ')} />}
        {cites.length > 0 && <MetaLine term="Sources" value={cites.join(', ')} />}
      </dl>
    </article>
  );
}

function MetaLine({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-foreground/40">{term}</dt>
      <dd className="min-w-0 flex-1">{value}</dd>
    </div>
  );
}

function MetaList({ term, items }: { term: string; items: string[] }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-foreground/40">{term}</dt>
      <dd className="min-w-0 flex-1">
        <ul className="list-disc space-y-0.5 pl-4">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      </dd>
    </div>
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

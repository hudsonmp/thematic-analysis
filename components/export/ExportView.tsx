'use client';

import { useMemo, useState, useTransition } from 'react';
import { codebookToLatex } from '@/lib/export/latex';
import type { CodebookTree, CodeWithRefs } from '@/app/actions/codebook';
import { exportCodebookJsonAction } from '@/app/(protected)/actions';

/**
 * The codebook export surface. The MAIN content is a RENDERED, already-compiled
 * HTML codebook table — what a researcher would paste into a paper appendix —
 * one row per code (current version), with the codebook's structured columns.
 * The LaTeX source is NOT shown on screen; it is still produced (pure,
 * client-side via `codebookToLatex`) only to back the unobtrusive "Download
 * .tex" button. JSON routes through the `exportCodebookJsonAction` SERVER action
 * because `lib/export/json.ts` is on the `server-only` import chain.
 *
 * Downloads build a Blob, click a transient anchor, then revoke. No Server
 * Action is invoked during render — the JSON action fires only from the click
 * handler.
 */
export default function ExportView({
  codebookId,
  tree,
}: {
  codebookId: string;
  tree: CodebookTree;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Pure LaTeX render — only used to back the .tex download (not shown).
  const latex = useMemo(() => codebookToLatex(tree), [tree]);

  function triggerDownload(filename: string, contents: string, mime: string) {
    const blob = new Blob([contents], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadLatex() {
    setError(null);
    triggerDownload('codebook.tex', latex, 'application/x-tex');
  }

  function downloadJson() {
    setError(null);
    startTransition(async () => {
      try {
        const json = await exportCodebookJsonAction(codebookId);
        triggerDownload('codebook.json', json, 'application/json');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'JSON export failed.');
      }
    });
  }

  // ----- table data (mirrors the LaTeX renderer's coercion + key resolution) --
  const keyById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of tree.citations) if (c.bibtex_key) m.set(c.id, c.bibtex_key);
    return m;
  }, [tree.citations]);

  const valueLabelById = useMemo(() => {
    const m = new Map<string, { facet: string; value: string }>();
    for (const f of tree.facets) {
      for (const v of f.values) m.set(v.id, { facet: f.label, value: v.label });
    }
    return m;
  }, [tree.facets]);

  // Only codes with a current version are renderable (no body = nothing to show).
  const rows = useMemo(
    () => tree.codes.filter((c) => c.current !== null),
    [tree.codes],
  );

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Codebook</h1>
          <p className="mt-2 max-w-2xl text-sm text-foreground/70">
            The compiled codebook table — one row per code, ready to lift into a
            paper appendix. Directed content analysis (Hsieh &amp; Shannon,
            2005); a coding-reliability codebook, not a reflexive account.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={downloadLatex}
            className="rounded border border-foreground/20 px-2.5 py-1 text-xs text-foreground/70 transition hover:bg-foreground/5"
          >
            Download .tex
          </button>
          <button
            type="button"
            onClick={downloadJson}
            disabled={isPending}
            className="rounded border border-foreground/20 px-2.5 py-1 text-xs text-foreground/70 transition hover:bg-foreground/5 disabled:opacity-50"
          >
            {isPending ? 'Exporting…' : 'Download JSON'}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      {rows.length === 0 ? (
        <div className="mt-8 border border-dashed border-foreground/20 p-8 text-center text-sm text-foreground/60">
          No coded entries yet. Codes appear here once they carry a current
          version (a definition + rules). Add one from the Scheme view, then give
          it an anatomy on its code page.
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto border border-foreground/15">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-foreground/5 text-left align-bottom">
                <Th>Mnemonic</Th>
                <Th>Definition</Th>
                <Th>Include-if</Th>
                <Th>Exclude-if</Th>
                <Th>Exemplar(s)</Th>
                <Th>Prediction</Th>
                <Th>Origin</Th>
                <Th>Facet tags</Th>
                <Th>Citations</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((code) => (
                <CodeRow
                  key={code.id}
                  code={code}
                  keyById={keyById}
                  valueLabelById={valueLabelById}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-r border-foreground/15 px-3 py-2 text-xs font-medium uppercase tracking-wider text-foreground/50 last:border-r-0">
      {children}
    </th>
  );
}

/** Mirrors `lib/export/latex.ts` coercion: tolerant Json → string[]. */
function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
}

/** Mirrors `lib/export/latex.ts`: exemplars are `{ text, source_pid? }`. */
function asExemplarStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (x && typeof x === 'object' && 'text' in x) {
      const text = (x as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) {
        const pid = (x as { source_pid?: unknown }).source_pid;
        out.push(
          typeof pid === 'string' && pid.trim() ? `${text} (${pid})` : text,
        );
      }
    } else if (typeof x === 'string' && x.trim()) {
      out.push(x);
    }
  }
  return out;
}

function ListCell({ items }: { items: string[] }) {
  if (items.length === 0) return <Em />;
  return (
    <ul className="list-disc space-y-0.5 pl-4">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

function TextCell({ value }: { value: string | null | undefined }) {
  const t = (value ?? '').trim();
  return t ? <>{t}</> : <Em />;
}

function Em() {
  return <span className="text-foreground/25">—</span>;
}

function CodeRow({
  code,
  keyById,
  valueLabelById,
}: {
  code: CodeWithRefs;
  keyById: Map<string, string>;
  valueLabelById: Map<string, { facet: string; value: string }>;
}) {
  const v = code.current!;
  const tags = code.facetValueIds
    .map((id) => valueLabelById.get(id))
    .filter((t): t is { facet: string; value: string } => t !== undefined)
    .map((t) => `${t.facet}: ${t.value}`);
  const cites = code.citationIds
    .map((id) => keyById.get(id))
    .filter((k): k is string => k !== undefined);

  return (
    <tr className="align-top">
      <Td>
        <span className="font-mono text-xs font-medium">{code.mnemonic}</span>
      </Td>
      <Td>
        <TextCell value={v.definition} />
      </Td>
      <Td>
        <ListCell items={asStringList(v.include_if)} />
      </Td>
      <Td>
        <ListCell items={asStringList(v.exclude_if)} />
      </Td>
      <Td>
        <ListCell items={asExemplarStrings(v.exemplars)} />
      </Td>
      <Td>
        <TextCell value={v.prediction} />
      </Td>
      <Td>
        <TextCell value={code.origin} />
      </Td>
      <Td>
        {tags.length === 0 ? (
          <Em />
        ) : (
          <div className="flex flex-wrap gap-1">
            {tags.map((t, i) => (
              <span
                key={i}
                className="border border-foreground/15 px-1.5 py-0.5 text-xs"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </Td>
      <Td>
        {cites.length === 0 ? (
          <Em />
        ) : (
          <span className="font-mono text-xs">{cites.join(', ')}</span>
        )}
      </Td>
    </tr>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="border-b border-r border-foreground/15 px-3 py-2 last:border-r-0">
      {children}
    </td>
  );
}

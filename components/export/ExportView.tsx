'use client';

import { useMemo, useState, useTransition } from 'react';
import { codebookToLatex } from '@/lib/export/latex';
import type { CodebookTree } from '@/app/actions/codebook';
import { exportCodebookJsonAction } from '@/app/(protected)/actions';

/**
 * The codebook export surface. Two artifacts:
 *
 *  - LaTeX (.tex): rendered CLIENT-SIDE via the PURE `codebookToLatex` (the tree
 *    is already a prop), so the methods-paragraph + longtable are produced
 *    without a round-trip. An optional facet selector groups the table by a
 *    facet's values. A live preview (first ~30 lines) lets the researcher eyeball
 *    the methods boilerplate and table head before downloading.
 *  - JSON (.json): produced by the `exportCodebookJsonAction` SERVER action,
 *    because `lib/export/json.ts` is on the `server-only` import chain (it reuses
 *    the service-role-backed `listCodebookTree`). The pure `buildSnapshot` is
 *    import-safe client-side, but routing through the action keeps the export
 *    shape single-sourced with the freeze artifact.
 *
 * Both downloads are triggered the same way: build a Blob, create an object URL,
 * click a transient anchor, then revoke. No Server Action is invoked during
 * render — the JSON action fires only from the button's click handler.
 */
export default function ExportView({
  codebookId,
  tree,
}: {
  codebookId: string;
  tree: CodebookTree;
}) {
  const [groupByFacetKey, setGroupByFacetKey] = useState<string>('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Pure render — recomputed only when the tree or the grouping choice changes.
  const latex = useMemo(
    () =>
      codebookToLatex(
        tree,
        groupByFacetKey ? { groupByFacetKey } : undefined,
      ),
    [tree, groupByFacetKey],
  );

  const preview = useMemo(
    () => latex.split('\n').slice(0, 30).join('\n'),
    [latex],
  );

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

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-lg font-medium tracking-tight">Export codebook</h1>
      <p className="mt-2 text-sm text-foreground/70">
        Download the codebook as a typeset LaTeX document (directed content
        analysis methods boilerplate + a code table) or as structured JSON.
      </p>

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-foreground/70">Group table by facet</span>
          <select
            value={groupByFacetKey}
            onChange={(e) => setGroupByFacetKey(e.target.value)}
            className="rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
          >
            <option value="">No grouping (flat table)</option>
            {tree.facets.map((f) => (
              <option key={f.id} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={downloadLatex}
          className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background transition hover:opacity-90"
        >
          Download LaTeX (.tex)
        </button>

        <button
          type="button"
          onClick={downloadJson}
          disabled={isPending}
          className="rounded border border-foreground/30 px-3 py-1.5 text-sm font-medium transition hover:bg-foreground/5 disabled:opacity-50"
        >
          {isPending ? 'Exporting…' : 'Download JSON (.json)'}
        </button>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-foreground/80">
          LaTeX preview (first 30 lines)
        </h2>
        <pre className="mt-2 overflow-x-auto rounded border border-foreground/15 bg-foreground/[0.03] p-4 text-xs leading-relaxed">
          {preview}
        </pre>
      </section>
    </main>
  );
}

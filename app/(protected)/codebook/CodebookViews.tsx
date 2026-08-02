'use client';

import { useState } from 'react';
import CodebookEntry from '@/components/codebook/CodebookEntry';
import FacetCanvas from '@/components/codebook/tree/FacetCanvas';
import CompositionView from './CompositionView';
import type { CodebookTree } from '@/app/actions/codebook';
import type { CombinatorialContext } from '@/app/actions/buckets';
import { toComboCodes } from '@/lib/codebook/comboCodes';

/**
 * The Codebook page has two views of ONE instrument, and they answer different
 * questions:
 *
 *   TREE — "what is the structure of my constructs, and what hangs where?"
 *          Authoring one code at a time, in context, with the scheme in front of
 *          you. The default, because that is the thinking surface.
 *   GRID — "get twenty codes in fast." Scheme-derived spreadsheet, bulk create.
 *
 * They are views, not modes: both write the same cb_codes / cb_labels rows, so a
 * code typed into the grid appears in the tree's Unplaced tray and can be dragged
 * into structure later. That is the point of letting codes exist before they have
 * a home.
 */
export default function CodebookViews({
  tree,
  combinatorial,
}: {
  tree: CodebookTree;
  /** Buckets + combinatorial defs (v2). Null on a load failure — the Buckets
   *  tab then simply doesn't render. */
  combinatorial: CombinatorialContext | null;
}) {
  const [view, setView] = useState<'tree' | 'grid' | 'buckets'>('tree');

  const tabs = combinatorial
    ? (['tree', 'grid', 'buckets'] as const)
    : (['tree', 'grid'] as const);
  const label = (v: string) =>
    v === 'tree' ? 'Tree' : v === 'grid' ? 'Bulk entry' : 'Buckets';
  const hint =
    view === 'tree'
      ? 'the structure of your constructs'
      : view === 'grid'
        ? 'get many codes in fast — they land Unplaced'
        : 'compose codes from step buckets — the set/subset relations';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-foreground/15 px-6 py-2">
        {tabs.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`px-2.5 py-1 text-xs transition ${
              view === v
                ? 'border-b border-foreground font-medium text-foreground'
                : 'text-foreground/50 hover:text-foreground'
            }`}
          >
            {label(v)}
          </button>
        ))}
        <span className="ml-3 text-xs text-foreground/40">{hint}</span>
      </div>

      {view === 'tree' ? (
        <FacetCanvas
          codebookId={tree.codebook.id}
          facets={tree.facets}
          codes={tree.codes}
          citations={tree.citations}
        />
      ) : view === 'grid' ? (
        <CodebookEntry
          codebookId={tree.codebook.id}
          facets={tree.facets}
          citations={tree.citations}
          labels={tree.labels}
        />
      ) : combinatorial ? (
        <CompositionView
          codebookId={tree.codebook.id}
          ctx={combinatorial}
          codeOptions={toComboCodes(tree.codes)}
        />
      ) : null}
    </div>
  );
}

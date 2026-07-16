'use client';

import { useState } from 'react';
import CodebookEntry from '@/components/codebook/CodebookEntry';
import FacetCanvas from '@/components/codebook/tree/FacetCanvas';
import type { CodebookTree } from '@/app/actions/codebook';

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
export default function CodebookViews({ tree }: { tree: CodebookTree }) {
  const [view, setView] = useState<'tree' | 'grid'>('tree');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-foreground/15 px-6 py-2">
        {(['tree', 'grid'] as const).map((v) => (
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
            {v === 'tree' ? 'Tree' : 'Bulk entry'}
          </button>
        ))}
        <span className="ml-3 text-xs text-foreground/40">
          {view === 'tree'
            ? 'the structure of your constructs'
            : 'get many codes in fast — they land Unplaced'}
        </span>
      </div>

      {view === 'tree' ? (
        <FacetCanvas
          codebookId={tree.codebook.id}
          facets={tree.facets}
          codes={tree.codes}
          citations={tree.citations}
        />
      ) : (
        <CodebookEntry
          codebookId={tree.codebook.id}
          facets={tree.facets}
          citations={tree.citations}
          labels={tree.labels}
        />
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import type { CodebookTree } from '@/app/actions/codebook';
import type { Tables } from '@/lib/types/cb-db';
import MatrixView from '@/components/matrix/MatrixView';
import LabelFolderView from '@/components/codebook/LabelFolderView';

type Citation = Tables<'cb_citations'>;

type View = 'matrix' | 'folders';

/**
 * The Scheme page shell: a Matrix | Folders toggle over one codebook tree.
 *
 * Two complementary browses of the SAME codebook. "Matrix" is the facet pivot
 * (MatrixView) — the default, so the page is non-disruptive for existing users.
 * "Folders" is the Finder-style label-hierarchy roll-up (LabelFolderView). The
 * toggle is the ONLY local state here; both views are otherwise driven entirely
 * by the `tree` the Server Component fetched.
 *
 * MatrixView's props (`tree`, `boundCitation`, including the deductive
 * "code-from-citation" binding) are threaded through UNCHANGED, so the matrix
 * behaves identically whether reached directly or via this shell. The folder view
 * needs only the tree (read-only label/code roll-up).
 */
export default function SchemeView({
  tree,
  boundCitation = null,
}: {
  tree: CodebookTree;
  boundCitation?: Citation | null;
}) {
  // Default to the matrix so the toggle is additive, never disruptive. When the
  // page is in deductive "code-from-citation" mode, the matrix carries the
  // new-code binding, so we keep Matrix as the natural landing view there too.
  const [view, setView] = useState<View>('matrix');

  return (
    <div className="flex flex-1 flex-col">
      {/* View toggle. Folders is a read-only browse; Matrix owns the new-code +
          deductive-coding affordances, so they stay inside MatrixView. */}
      <div className="flex items-center gap-1 px-6 pt-6">
        <div className="inline-flex border border-foreground/20 text-sm">
          {(['matrix', 'folders'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`px-3 py-1 capitalize transition ${
                view === v
                  ? 'bg-foreground text-background'
                  : 'text-foreground/60 hover:text-foreground'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === 'matrix' ? (
        <MatrixView tree={tree} boundCitation={boundCitation} />
      ) : (
        <main className="flex-1 px-6 py-6 space-y-6">
          <h1 className="text-xl font-medium tracking-tight">Scheme · Folders</h1>
          <p className="max-w-3xl text-sm leading-relaxed text-foreground/60 border-l-2 border-foreground/15 pl-3">
            Browse codes by your nested <span className="font-medium text-foreground/80">label</span>{' '}
            vocabulary. Each folder rolls up every code tagged on it or anywhere in
            its subtree; a code with several labels appears under each. Expand a
            folder to list its codes.
          </p>
          <LabelFolderView tree={tree} />
        </main>
      )}
    </div>
  );
}

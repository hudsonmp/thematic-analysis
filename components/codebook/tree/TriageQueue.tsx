'use client';

import { useMemo, useState } from 'react';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { queueStats, triageQueue } from '@/lib/codebook/triage';
import type { Tables } from '@/lib/types/cb-db';
import CodeEditor from './CodeEditor';

type Citation = Tables<'cb_citations'>;

/**
 * The triage queue: classify — and EDIT — the codes you captured while reading.
 *
 * WHY IT EXISTS. Capture and classification are different cognitive modes. To classify
 * at capture time you must hold the whole scheme in working memory WHILE reading, so you
 * capture less and worse. Batching lets you load the scheme once and apply it N times.
 * The floating `+` therefore asks for nothing but the code; this is where the asking
 * happens.
 *
 * IT IS A LIST, NOT A CURSOR. It used to serve one code at a time behind ←/skip arrows.
 * That is a queue you cannot LOOK at: you could never see that four of your seven
 * captures were the same idea, because only one was ever on screen. Triage is not only
 * "answer the questions" — it is also "notice what you actually collected", and noticing
 * requires the set to be visible at once. Click a row to open it; edits commit on blur,
 * so clicking away loses nothing.
 *
 * Ordering is MOST-INCOMPLETE-FIRST with an alphabetical tiebreak, so the worst debt
 * surfaces first and the list cannot reshuffle under the cursor between renders.
 */
export default function TriageQueue({
  codes,
  facets,
  citations,
}: {
  codes: CodeWithRefs[];
  /** The answerable dimensions. A facet with no values is a question with no possible
   *  answer — parking codes behind it would be an unclearable debt. */
  facets: FacetWithValues[];
  /** The citation library — so a paper can be attached POST HOC. */
  citations: Citation[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  const queue = useMemo(() => triageQueue(codes, facets), [codes, facets]);
  const stats = useMemo(() => queueStats(codes, facets), [codes, facets]);

  if (queue.length === 0) {
    return (
      <p className="py-3 text-xs text-foreground/45">
        {stats.total === 0
          ? 'No codes yet. The corner + captures one without asking you to classify it.'
          : `All ${stats.total} codes are classified on every dimension.`}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-foreground/45">
        {queue.length} unclassified
        {stats.fullyUncategorized > 0 &&
          ` · ${stats.fullyUncategorized} with no answers at all`}
        {' · '}most incomplete first
      </p>

      <div className="space-y-1">
        {queue.map((item) => {
          const code = item.code;
          const open = openId === code.id;
          return (
            <div key={code.id} className="border border-foreground/15">
              {/* Draggable from the LIST as well as the staging box: the two are views of
                  the SAME unfiled pile, so a code must be draggable wherever it is shown
                  or the two views disagree about what you are allowed to do with it. */}
              <div
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/code-id', code.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => setOpenId(open ? null : code.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenId(open ? null : code.id);
                  }
                }}
                className={`flex cursor-grab items-baseline gap-2 px-2 py-1.5 text-left transition active:cursor-grabbing ${
                  open ? 'bg-foreground/[0.04]' : 'hover:bg-foreground/[0.03]'
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/70">
                  {code.mnemonic}
                </span>
                <span
                  className="shrink-0 text-[11px] text-amber-700 dark:text-amber-500"
                  title={`${item.gaps.length} unanswered dimension${item.gaps.length === 1 ? '' : 's'}`}
                >
                  {item.gaps.length}
                </span>
              </div>

              {open && (
                <div className="border-t border-foreground/10 p-2">
                  {/* The SAME editor the inspector uses. A code must be edited identically
                      wherever you meet it — three partial editors that drift apart is the
                      failure this avoids. A successful "Save version" collapses the row
                      (the queue's own dismiss path); a failed save keeps it open. */}
                  <CodeEditor
                    code={code}
                    facets={facets}
                    citations={citations}
                    allCodes={codes}
                    onSaved={() => setOpenId(null)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

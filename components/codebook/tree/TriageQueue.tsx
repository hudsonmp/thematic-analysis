'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { addCodeFacetValue, removeCodeFacetValue, renameCode } from '@/app/actions/codes';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { queueStats, triageQueue } from '@/lib/codebook/triage';

/**
 * The triage queue: classify the codes you captured while reading, later.
 *
 * WHY IT EXISTS. Capture and classification are different cognitive modes. To
 * classify at capture time you must hold the whole scheme in working memory WHILE
 * reading — so you capture less, and you capture worse. Batching classification lets
 * you load the scheme once and apply it N times. The floating `+` therefore asks for
 * nothing but the code; this is where the asking happens.
 *
 * It serves ONE code at a time with every dimension in front of you, rather than
 * offering a per-dimension bucket you fill column by column. Per-column filling never
 * forces a code to be finished, so codes stay half-classified indefinitely — and a
 * half-classified code is invisible in exactly the dimension you forgot.
 *
 * Ordering is MOST-INCOMPLETE-FIRST (`triageQueue`), so the worst debt surfaces
 * first, with an alphabetical tiebreak so the list is deterministic and cannot
 * reshuffle under the cursor between renders.
 *
 * It does NOT auto-advance on save. Auto-advance makes a batch feel like one pass,
 * but it also makes a misclick expensive: the code you just mis-answered is gone from
 * the screen before you notice. The cursor stays put; you advance deliberately.
 */
export default function TriageQueue({
  codes,
  facets,
}: {
  codes: CodeWithRefs[];
  /** The answerable dimensions. A facet with no values is a question with no possible
   *  answer — parking codes behind it would be an unclearable debt. */
  facets: FacetWithValues[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cursor, setCursor] = useState(0);

  const queue = useMemo(() => triageQueue(codes, facets), [codes, facets]);
  const stats = useMemo(() => queueStats(codes, facets), [codes, facets]);

  // The queue re-derives from fresh props after every write, so answering a code's
  // last gap removes it and the item at `cursor` becomes the NEXT one automatically.
  // Clamp rather than let the cursor run off the end.
  const index = Math.min(cursor, Math.max(queue.length - 1, 0));
  const item = queue[index];

  function run(fn: () => Promise<unknown>) {
    start(async () => {
      await fn();
      router.refresh();
    });
  }

  if (queue.length === 0) {
    return (
      <p className="py-3 text-xs text-foreground/45">
        {stats.total === 0
          ? 'No codes yet. The corner + captures one without asking you to classify it.'
          : `All ${stats.total} codes are classified on every dimension.`}
      </p>
    );
  }

  const code = item.code;
  const gapIds = new Set(item.gaps.map((g) => g.facetId));

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium">
          {index + 1} / {queue.length}
        </span>
        <span className="text-foreground/45">
          {stats.fullyUncategorized > 0 &&
            `${stats.fullyUncategorized} with no answers at all · `}
          most incomplete first
        </span>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={() => setCursor((c) => Math.max(c - 1, 0))}
            disabled={index === 0}
            className="border border-foreground/20 px-2 py-0.5 transition enabled:hover:border-foreground disabled:opacity-30"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => setCursor((c) => Math.min(c + 1, queue.length - 1))}
            disabled={index >= queue.length - 1}
            className="border border-foreground/20 px-2 py-0.5 transition enabled:hover:border-foreground disabled:opacity-30"
          >
            skip →
          </button>
        </div>
      </div>

      <div className="border border-foreground/15 p-3">
        {/* The mnemonic is editable HERE because this is where you SEE it — an
            auto-derived `ANALYSIS-BEHAVIOR` only looks wrong once it is sitting next to
            its siblings. It is a display handle, never an identity (everything
            references cb_codes.id), so renaming it breaks nothing. */}
        <div className="flex items-baseline gap-2">
          <MnemonicField key={code.id} codeId={code.id} value={code.mnemonic} />
          <span className="text-sm font-medium">{code.name}</span>
        </div>
        {code.current?.definition && (
          <p className="mt-1 text-xs leading-relaxed text-foreground/60">
            {code.current.definition}
          </p>
        )}

        <div className="mt-3 space-y-2">
          {facets.map((f) => {
            const multi = f.cardinality === 'multi';
            const mine = f.values.filter((v) => code.facetValueIds.includes(v.id));
            const isGap = gapIds.has(f.id);
            return (
              <div key={f.id} className="flex flex-wrap items-baseline gap-1.5">
                <span
                  className={`w-28 shrink-0 text-xs ${
                    isGap ? 'font-medium text-foreground/80' : 'text-foreground/45'
                  }`}
                >
                  {f.label}
                  {/* The unanswered dimensions are what this screen is FOR — mark them,
                      so a code with four answered and one blank reads instantly. */}
                  {isGap && <span className="ml-1 text-amber-700 dark:text-amber-500">·</span>}
                </span>
                <div className="flex flex-wrap gap-1">
                  {f.values.map((v) => {
                    const on = mine.some((m) => m.id === v.id);
                    return (
                      <button
                        key={v.id}
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(async () => {
                            if (on) {
                              await removeCodeFacetValue(code.id, v.id);
                              return;
                            }
                            // A `single` dimension admits one answer: a new pick
                            // REPLACES the old, or the code would silently carry two
                            // answers on a dimension declared to allow only one.
                            if (!multi) {
                              for (const m of mine) {
                                await removeCodeFacetValue(code.id, m.id);
                              }
                            }
                            await addCodeFacetValue(code.id, v.id);
                          })
                        }
                        className={`border px-2 py-0.5 text-xs transition ${
                          on
                            ? 'border-foreground bg-foreground text-background'
                            : 'border-foreground/20 text-foreground/60 enabled:hover:border-foreground/60'
                        }`}
                      >
                        {v.label}
                      </button>
                    );
                  })}
                </div>
                {mine.length > 1 && (
                  <span className="text-xs text-amber-700 dark:text-amber-500">
                    cross-cuts
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline mnemonic editor. Commits on blur or Enter, reverts on Escape. A failed commit
 * (a UNIQUE collision with another code in this codebook) restores the previous value
 * and surfaces the error, rather than leaving the field showing text that was never
 * saved — a silent no-op is the worst outcome for a field you deliberately changed.
 */
function MnemonicField({ codeId, value }: { codeId: string; value: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function commit() {
    const next = draft.trim();
    if (next === '' || next === value) {
      setDraft(value);
      return;
    }
    start(async () => {
      try {
        await renameCode(codeId, { mnemonic: next });
        setError(null);
        router.refresh();
      } catch (e) {
        setDraft(value);
        setError(e instanceof Error ? e.message : 'Rename failed.');
      }
    });
  }

  return (
    <span className="inline-flex flex-col">
      <input
        value={draft}
        disabled={pending}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
        size={Math.max(draft.length, 4)}
        aria-label="Mnemonic"
        title="Edit the mnemonic — it is a display handle, not an identity"
        className="border-b border-dashed border-foreground/25 bg-transparent font-mono text-sm text-foreground/70 focus:border-solid focus:border-foreground focus:outline-none"
      />
      {error && <span className="text-[10px] text-red-600">{error}</span>}
    </span>
  );
}

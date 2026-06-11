'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setCodeLabels } from '@/app/actions/labels';
import type { Tables } from '@/lib/types/cb-db';

type Label = Tables<'cb_labels'>;

// Fallback swatch color for a label with no color set (so the dot always reads).
const DEFAULT_SWATCH = '#000000';

/**
 * Label-tag editor for a code. Checkbox-style toggles over the codebook's labels
 * (cb_labels) marking which themes the code is grouped under — the categorical /
 * "what kind" axis, orthogonal to facet classification, to episodes (temporal),
 * and to per-session marks. Every toggle recomputes the FULL selected set and
 * calls `setCodeLabels(codeId, allIds)` (the action replaces the whole set),
 * then router.refresh() so the matrix label filter re-reads. Selection is held
 * in local state for snappy feedback, seeded from `selectedLabelIds`, and rolled
 * back to server truth on error. Mirrors EpisodeTagger exactly.
 */
export default function LabelTagger({
  codeId,
  labels,
  selectedLabelIds,
}: {
  codeId: string;
  labels: Label[];
  selectedLabelIds: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(selectedLabelIds));

  function commit(next: Set<string>) {
    setSelected(next);
    setError(null);
    startTransition(async () => {
      try {
        await setCodeLabels(codeId, [...next]);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save label tags.');
        setSelected(new Set(selectedLabelIds)); // roll back to server truth
      }
    });
  }

  function toggle(labelId: string) {
    const next = new Set(selected);
    if (next.has(labelId)) next.delete(labelId);
    else next.add(labelId);
    commit(next);
  }

  if (labels.length === 0) {
    return (
      <p className="text-sm text-foreground/50">
        No labels defined yet — add labels on the Labels page to group this code.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-xs text-foreground/50">
        Group this code under themes. The matrix can filter codes by label.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {labels.map((lbl) => {
          const isOn = selected.has(lbl.id);
          return (
            <button
              key={lbl.id}
              type="button"
              disabled={isPending}
              onClick={() => toggle(lbl.id)}
              aria-pressed={isOn}
              className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs transition disabled:opacity-50 ${
                isOn
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-foreground/20 hover:border-foreground'
              }`}
            >
              <span
                className="inline-block h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: lbl.color ?? DEFAULT_SWATCH }}
                aria-hidden
              />
              {lbl.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

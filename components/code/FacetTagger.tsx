'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setCodeFacetValues } from '@/app/actions/codes';
import type { FacetWithValues } from '@/app/actions/codebook';

/**
 * Toggles which facet values this code carries. Respects cardinality:
 *   - 'single' → radio semantics per facet (picking a value replaces any other
 *     value already selected on that SAME facet; a value can be cleared by
 *     re-clicking it, returning the facet to "unset").
 *   - 'multi'  → checkbox semantics (independent toggles).
 *
 * Every toggle recomputes the FULL selected-value-id set across all facets and
 * calls `setCodeFacetValues(codeId, allIds)` (the action replaces the whole set,
 * so we always send the complete picture), then router.refresh() so the matrix /
 * tree re-read. Selection is held in local state for snappy feedback and seeded
 * from the server-provided `selectedValueIds`.
 */
export default function FacetTagger({
  codeId,
  facets,
  selectedValueIds,
}: {
  codeId: string;
  facets: FacetWithValues[];
  selectedValueIds: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(selectedValueIds));

  function commit(next: Set<string>) {
    setSelected(next);
    setError(null);
    startTransition(async () => {
      try {
        await setCodeFacetValues(codeId, [...next]);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save tags.');
        setSelected(new Set(selectedValueIds)); // roll back to server truth
      }
    });
  }

  function toggle(facet: FacetWithValues, valueId: string) {
    const next = new Set(selected);
    if (facet.cardinality === 'single') {
      const wasSelected = next.has(valueId);
      // Clear every value on THIS facet, then re-add unless we were toggling off.
      for (const v of facet.values) next.delete(v.id);
      if (!wasSelected) next.add(valueId);
    } else {
      if (next.has(valueId)) next.delete(valueId);
      else next.add(valueId);
    }
    commit(next);
  }

  if (facets.length === 0) {
    return (
      <p className="text-sm text-foreground/50">
        No facets defined yet — add facets on the Scheme page to classify this code.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {facets.map((facet) => (
        <fieldset key={facet.id} className="space-y-1.5">
          <legend className="text-xs uppercase tracking-wider text-foreground/50">
            {facet.label}{' '}
            <span className="text-foreground/30 normal-case">({facet.cardinality})</span>
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {facet.values.length === 0 && (
              <span className="text-xs text-foreground/30">No values on this facet.</span>
            )}
            {facet.values.map((value) => {
              const isOn = selected.has(value.id);
              return (
                <button
                  key={value.id}
                  type="button"
                  disabled={isPending}
                  onClick={() => toggle(facet, value.id)}
                  aria-pressed={isOn}
                  className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs transition disabled:opacity-50 ${
                    isOn
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-foreground/20 hover:border-foreground'
                  }`}
                >
                  {value.color && (
                    <span
                      className="inline-block h-2 w-2 rounded-sm shrink-0"
                      style={{ backgroundColor: value.color }}
                      aria-hidden
                    />
                  )}
                  {value.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

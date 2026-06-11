'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setCodeFacetValues } from '@/app/actions/codes';
import { linkCitation, unlinkCitation } from '@/app/actions/citations';
import type { FacetWithValues } from '@/app/actions/codebook';
import type { Tables } from '@/lib/types/cb-db';

type Citation = Tables<'cb_citations'>;

/**
 * Toggles which facet values this code carries, plus a built-in, always-present,
 * OPTIONAL virtual "Citations" facet rendered alongside the real facets.
 *
 * Real facets respect cardinality:
 *   - 'single' → radio semantics per facet (picking a value replaces any other
 *     value already selected on that SAME facet; a value can be cleared by
 *     re-clicking it, returning the facet to "unset").
 *   - 'multi'  → checkbox semantics (independent toggles).
 *
 * Every real-facet toggle recomputes the FULL selected-value-id set across all
 * facets and calls `setCodeFacetValues(codeId, allIds)` (the action replaces the
 * whole set, so we always send the complete picture), then router.refresh() so
 * the matrix / tree re-read.
 *
 * The virtual "Citations" facet is NOT a cb_facets row: its "values" are the
 * codebook's cb_citations, and code↔value membership IS a cb_code_citations row.
 * It behaves like a multi facet, but instead of writing facet-value links it
 * links/unlinks citations: toggling on → linkCitation(codeId, id, 'related')
 * (role 'related' marks a hand-link, distinct from the deductive-flow
 * 'derived_from'); toggling off → unlinkCitation(codeId, id). The pre-checked
 * set is the code's existing linked citations REGARDLESS of role, so a
 * 'derived_from' link from the code-from-citation flow also shows as checked.
 * It is optional everywhere — empty is the default and fine.
 *
 * Both selection sets are held in local state for snappy feedback and seeded
 * from the server-provided props; on error each rolls back to server truth.
 */
export default function FacetTagger({
  codeId,
  facets,
  selectedValueIds,
  citations,
  linkedCitationIds,
}: {
  codeId: string;
  facets: FacetWithValues[];
  selectedValueIds: string[];
  citations: Citation[];
  linkedCitationIds: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(selectedValueIds));
  const [linkedCitations, setLinkedCitations] = useState<Set<string>>(
    new Set(linkedCitationIds),
  );

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

  /**
   * Toggle a citation link on this code (the virtual Citations facet). Multi
   * semantics: each citation is an independent on/off. Optimistically flip local
   * state, write the link/unlink, refresh; roll back to server truth on error.
   */
  function toggleCitation(citationId: string) {
    const wasLinked = linkedCitations.has(citationId);
    const next = new Set(linkedCitations);
    if (wasLinked) next.delete(citationId);
    else next.add(citationId);
    setLinkedCitations(next);
    setError(null);
    startTransition(async () => {
      try {
        if (wasLinked) await unlinkCitation(codeId, citationId);
        else await linkCitation(codeId, citationId, 'related');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to link citation.');
        setLinkedCitations(new Set(linkedCitationIds)); // roll back to server truth
      }
    });
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {facets.length === 0 ? (
        <p className="text-sm text-foreground/50">
          No facets defined yet — add facets on the Scheme page to classify this code.
        </p>
      ) : (
        facets.map((facet) => (
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
        ))
      )}

      {/* Virtual, always-present, OPTIONAL "Citations" facet. Its options are the
          codebook's citations; toggling one links/unlinks a cb_code_citations row
          ('related' role for a hand-link). Reflects ALL existing links regardless
          of role (so deductive 'derived_from' links also show as checked). */}
      <fieldset className="space-y-1.5">
        <legend className="text-xs uppercase tracking-wider text-foreground/50">
          Citations{' '}
          <span className="text-foreground/30 normal-case">(optional · multi)</span>
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {citations.length === 0 ? (
            <span className="text-xs text-foreground/30">
              No citations in this codebook — paste BibTeX on the Citations page to add some.
            </span>
          ) : (
            citations.map((c) => {
              const isOn = linkedCitations.has(c.id);
              const label = c.bibtex_key || c.title || c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={isPending}
                  onClick={() => toggleCitation(c.id)}
                  aria-pressed={isOn}
                  title={c.title ?? undefined}
                  className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs transition disabled:opacity-50 ${
                    isOn
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-foreground/20 hover:border-foreground'
                  }`}
                >
                  <span className="font-mono">{label}</span>
                </button>
              );
            })
          )}
        </div>
      </fieldset>
    </div>
  );
}

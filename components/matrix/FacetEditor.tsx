'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createFacet,
  renameFacet,
  deleteFacet,
  createFacetValue,
  updateFacetValue,
  deleteFacetValue,
  type Cardinality,
} from '@/app/actions/facets';
import type { FacetWithValues } from '@/app/actions/codebook';
import { type FacetType, coerceFacetType, facetHasValues } from '@/lib/codebook/facet-types';

/**
 * Collapsible "Edit scheme" panel. Calls the facets Server Actions from event
 * handlers (NOT during render) and `router.refresh()` after each mutation so
 * the parent Server Component re-fetches the codebook tree. Mutations run inside
 * a transition so the panel can show a coarse "saving" state and disable the
 * controls while the refresh round-trips.
 */
export default function FacetEditor({
  codebookId,
  facets,
}: {
  codebookId: string;
  facets: FacetWithValues[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(facets.length === 0);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // new-facet form
  const [fKey, setFKey] = useState('');
  const [fLabel, setFLabel] = useState('');
  const [fCard, setFCard] = useState<Cardinality>('single');
  const [fType, setFType] = useState<FacetType>('enum');

  // per-facet new-value drafts, keyed by facet id
  const [valueDrafts, setValueDrafts] = useState<
    Record<string, { key: string; label: string; color: string }>
  >({});

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Mutation failed.');
      }
    });
  }

  function draftFor(facetId: string) {
    return valueDrafts[facetId] ?? { key: '', label: '', color: '' };
  }
  function setDraft(facetId: string, patch: Partial<{ key: string; label: string; color: string }>) {
    setValueDrafts((prev) => ({
      ...prev,
      [facetId]: { ...draftFor(facetId), ...patch },
    }));
  }

  return (
    <section className="border border-foreground/15">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2 text-sm text-foreground/70 hover:text-foreground"
        aria-expanded={open}
      >
        <span>Edit scheme {isPending && <span className="text-foreground/40">· saving…</span>}</span>
        <span className="text-foreground/40">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="border-t border-foreground/15 p-4 space-y-6">
          {error && <p className="text-sm text-red-600">{error}</p>}

          {/* Existing facets */}
          {facets.map((facet) => {
            const facetType = coerceFacetType(facet.type);
            const showValues = facetHasValues(facetType);
            return (
            <div key={facet.id} className="border border-foreground/10 p-3 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  defaultValue={facet.label}
                  disabled={isPending}
                  onBlur={(e) => {
                    const label = e.target.value.trim();
                    if (label && label !== facet.label) {
                      run(() => renameFacet(facet.id, { label }));
                    }
                  }}
                  className="border border-foreground/15 px-2 py-1 text-sm bg-background"
                  aria-label={`Rename facet ${facet.label}`}
                />
                <span className="text-xs text-foreground/40 font-mono">{facet.key}</span>
                <span className="text-xs text-foreground/40">
                  ({facetType === 'open_text' ? 'open response' : facetType}
                  {showValues ? ` · ${facet.cardinality}` : ''})
                </span>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    if (confirm(`Delete facet "${facet.label}" and its values?`)) {
                      run(() => deleteFacet(facet.id));
                    }
                  }}
                  className="ml-auto text-xs text-red-600 hover:underline disabled:opacity-50"
                >
                  Delete facet
                </button>
              </div>

              {/* Values + add-value are ENUM-only: boolean / open_text facets are
                  valueless (their per-code datum lives in cb_code_facet_fields). */}
              {!showValues && (
                <p className="pl-2 text-xs text-foreground/40">
                  {facetType === 'boolean'
                    ? 'Yes/no facet — no values. Each code gets a yes/no on its card.'
                    : 'Open-response facet — no values. Each code gets a free-text note on its card.'}
                </p>
              )}

              {showValues && (<>
              {/* Values */}
              <ul className="space-y-1.5 pl-2">
                {facet.values.map((value) => (
                  <li key={value.id} className="flex items-center gap-2">
                    <input
                      type="color"
                      defaultValue={value.color ?? '#cccccc'}
                      disabled={isPending}
                      onBlur={(e) => {
                        const color = e.target.value;
                        if (color !== (value.color ?? '#cccccc')) {
                          run(() => updateFacetValue(value.id, { color }));
                        }
                      }}
                      className="h-6 w-6 border border-foreground/15 bg-background p-0"
                      aria-label={`Color for ${value.label}`}
                    />
                    <input
                      defaultValue={value.label}
                      disabled={isPending}
                      onBlur={(e) => {
                        const label = e.target.value.trim();
                        if (label && label !== value.label) {
                          run(() => updateFacetValue(value.id, { label }));
                        }
                      }}
                      className="border border-foreground/15 px-2 py-1 text-sm bg-background"
                      aria-label={`Rename value ${value.label}`}
                    />
                    <span className="text-xs text-foreground/40 font-mono">{value.key}</span>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => {
                        if (confirm(`Delete value "${value.label}"?`)) {
                          run(() => deleteFacetValue(value.id));
                        }
                      }}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>

              {/* Add value */}
              <div className="flex items-center gap-2 pl-2 flex-wrap">
                <input
                  value={draftFor(facet.id).key}
                  onChange={(e) => setDraft(facet.id, { key: e.target.value })}
                  placeholder="key"
                  disabled={isPending}
                  className="border border-foreground/15 px-2 py-1 text-xs bg-background w-24"
                  aria-label={`New value key for ${facet.label}`}
                />
                <input
                  value={draftFor(facet.id).label}
                  onChange={(e) => setDraft(facet.id, { label: e.target.value })}
                  placeholder="label"
                  disabled={isPending}
                  className="border border-foreground/15 px-2 py-1 text-xs bg-background"
                  aria-label={`New value label for ${facet.label}`}
                />
                <input
                  type="color"
                  value={draftFor(facet.id).color || '#cccccc'}
                  onChange={(e) => setDraft(facet.id, { color: e.target.value })}
                  disabled={isPending}
                  className="h-6 w-6 border border-foreground/15 bg-background p-0"
                  aria-label={`New value color for ${facet.label}`}
                />
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    const d = draftFor(facet.id);
                    const key = d.key.trim();
                    const label = d.label.trim();
                    if (!key || !label) {
                      setError('Value needs a key and a label.');
                      return;
                    }
                    run(async () => {
                      await createFacetValue(facet.id, {
                        key,
                        label,
                        color: d.color || undefined,
                      });
                      setValueDrafts((prev) => ({ ...prev, [facet.id]: { key: '', label: '', color: '' } }));
                    });
                  }}
                  className="border border-foreground/30 px-2 py-1 text-xs hover:bg-foreground hover:text-background transition disabled:opacity-50"
                >
                  Add value
                </button>
              </div>
              </>)}
            </div>
            );
          })}

          {/* Add facet */}
          <div className="border-t border-foreground/10 pt-4">
            <p className="text-xs uppercase tracking-wider text-foreground/50 mb-2">New facet</p>
            <div className="flex items-end gap-2 flex-wrap">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-foreground/50">
                  key{' '}
                  <span className="text-foreground/35">
                    — machine id: lowercase, no spaces (e.g.{' '}
                    <span className="font-mono">stage</span>)
                  </span>
                </span>
                <input
                  value={fKey}
                  onChange={(e) => setFKey(e.target.value)}
                  placeholder="stage"
                  disabled={isPending}
                  title="Machine id — lowercase, no spaces (e.g. stage). Used internally; not shown in the matrix."
                  className="border border-foreground/15 px-2 py-1 text-sm bg-background w-40 font-mono"
                  aria-label="New facet key"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-foreground/50">
                  label{' '}
                  <span className="text-foreground/35">
                    — display name (e.g. Stage)
                  </span>
                </span>
                <input
                  value={fLabel}
                  onChange={(e) => setFLabel(e.target.value)}
                  placeholder="Stage"
                  disabled={isPending}
                  title="Display name shown in the matrix axes (e.g. Stage)."
                  className="border border-foreground/15 px-2 py-1 text-sm bg-background"
                  aria-label="New facet label"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-foreground/50">
                  type{' '}
                  <span className="text-foreground/35">— how codes carry it</span>
                </span>
                <select
                  value={fType}
                  onChange={(e) => setFType(e.target.value as FacetType)}
                  disabled={isPending}
                  title="enum = pick from a list of values. yes/no = a boolean per code. open response = a free-text note per code."
                  className="border border-foreground/15 px-2 py-1 text-sm bg-background"
                  aria-label="New facet type"
                >
                  <option value="enum">enum — pick from values</option>
                  <option value="boolean">yes/no — a boolean per code</option>
                  <option value="open_text">open response — free text per code</option>
                </select>
              </label>
              {fType === 'enum' && (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-foreground/50">
                    cardinality{' '}
                    <span className="text-foreground/35">— values per code</span>
                  </span>
                  <select
                    value={fCard}
                    onChange={(e) => setFCard(e.target.value as Cardinality)}
                    disabled={isPending}
                    title="single = a code gets at most ONE value on this facet (radio). multi = a code can carry SEVERAL values (checkboxes)."
                    className="border border-foreground/15 px-2 py-1 text-sm bg-background"
                    aria-label="New facet cardinality"
                  >
                    <option value="single">single — at most one value (radio)</option>
                    <option value="multi">multi — several values (checkboxes)</option>
                  </select>
                </label>
              )}
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  const key = fKey.trim();
                  const label = fLabel.trim();
                  if (!key || !label) {
                    setError('Facet needs a key and a label.');
                    return;
                  }
                  run(async () => {
                    await createFacet(codebookId, {
                      key,
                      label,
                      cardinality: fCard,
                      type: fType,
                    });
                    setFKey('');
                    setFLabel('');
                    setFCard('single');
                    setFType('enum');
                  });
                }}
                className="border border-foreground px-3 py-1 text-sm hover:bg-foreground hover:text-background transition disabled:opacity-50"
              >
                Add facet
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

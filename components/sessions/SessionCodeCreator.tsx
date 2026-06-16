'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { createCode, setCodeFacetValues, setCodeFacetField } from '@/app/actions/codes';
import type { CodeOrigin } from '@/app/actions/codes';
import { setCodeLabels } from '@/app/actions/labels';
import type { FacetWithValues } from '@/app/actions/codebook';
import type { CodeVersionInputT } from '@/lib/types/contracts';
import type { Tables } from '@/lib/types/cb-db';
import { deriveMnemonic } from '@/lib/codebook/mnemonic';
import { facetRenderMode, coerceFacetType } from '@/lib/codebook/facet-types';

type Label = Tables<'cb_labels'>;

/** Session-mode options (code origin), mirroring CodebookEntry's ORIGINS. */
const ORIGINS: { value: CodeOrigin; label: string }[] = [
  { value: 'a_priori', label: 'a priori' },
  { value: 'pilot', label: 'pilot' },
  { value: 'emergent', label: 'emergent' },
];

/**
 * A facet's in-progress value while the new code is being drafted, discriminated
 * by the facet's render mode — the local-state analogue of `FacetCell`
 * (lib/codebook/grid.ts), held here per facet id:
 *   - enum-single → at most one selected value id (`valueIds` length 0 or 1);
 *   - enum-multi  → any number of selected value ids;
 *   - boolean     → tri-state (null = unset / true / false);
 *   - open-text   → a free string ('' = unset).
 * On submit these are translated into the same two DB writes the rest of the app
 * uses: enum value ids → `setCodeFacetValues`; boolean/open_text → `setCodeFacetField`.
 */
type DraftFacet =
  | { kind: 'enum'; valueIds: string[] }
  | { kind: 'boolean'; bool: boolean | null }
  | { kind: 'open_text'; text: string };

/**
 * Quick "add a code to the codebook" panel for the session coding page. A compact
 * card: Name (the only required field), Origin, an optional one-line Definition,
 * one input per facet (rendered by the facet's TYPE via `facetRenderMode`,
 * mirroring FacetTagger), and a read-only system `Study` field showing the
 * session's auto-assigned authoring study.
 *
 * On submit it creates the code with a minimal first version (definition falls
 * back to the name, exactly like the bulk-entry path), then applies the facet
 * inputs (enum value ids in one `setCodeFacetValues` call; each set boolean /
 * open_text facet via `setCodeFacetField`). `studyLabel` is threaded through to
 * `createCode` as the per-code study attribution. After a successful create the
 * form resets (origin is kept) and `onCreated` fires so the parent can refresh
 * its code picker.
 */
export default function SessionCodeCreator({
  codebookId,
  facets,
  labels,
  studyLabel,
  onCreated,
}: {
  codebookId: string;
  facets: FacetWithValues[];
  /** The codebook's labels (themes). OPTIONAL to assign — a code may carry none.
   *  Empty array hides the picker entirely. */
  labels: Label[];
  /** The session's collection — auto-assigned authoring study (read-only display,
   *  passed to createCode as studyLabel). Null outside a session context. */
  studyLabel: string | null;
  /** Called after a successful create so the parent can refresh the code picker. */
  onCreated?: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState<CodeOrigin>('emergent');
  const [definition, setDefinition] = useState('');
  // Per-facet draft value, keyed by facetId. Seeded empty for every facet; a
  // missing key is treated as "unset" (defensive against facets changing).
  const [draftFacets, setDraftFacets] = useState<Map<string, DraftFacet>>(new Map());
  // OPTIONAL label tags for the new code (the categorical "what kind" axis). Empty
  // by default — labeling is never required.
  const [selectedLabelIds, setSelectedLabelIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Facets in scheme order (by `position`). Defensive copy so we never mutate the
  // prop array; a facet with no values still renders (empty select).
  const orderedFacets = useMemo(
    () => [...facets].sort((a, b) => a.position - b.position),
    [facets],
  );

  function modeOf(facet: FacetWithValues) {
    return facetRenderMode(
      coerceFacetType(facet.type),
      facet.cardinality === 'multi' ? 'multi' : 'single',
    );
  }

  function setFacet(facetId: string, value: DraftFacet) {
    setDraftFacets((prev) => {
      const next = new Map(prev);
      next.set(facetId, value);
      return next;
    });
  }

  const nameTrimmed = name.trim();
  const canSubmit = nameTrimmed.length > 0 && !isPending;

  function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setError(null);

    // Minimal valid CodeVersionInput: definition (Zod .min(1)) falls back to the
    // name when blank (the bulk-entry convention), plus the three required arrays.
    // The optional fields (disconfirming_pattern / prediction / prediction_falsifier
    // / change_note) are omitted.
    const version: CodeVersionInputT = {
      definition: definition.trim() || trimmedName,
      include_if: [],
      exclude_if: [],
      exemplars: [],
    };

    // Translate the per-facet drafts into the two DB write shapes, only for facets
    // that exist + carry a value (mirrors rowToFacetWrites / FacetTagger).
    const enumValueIds: string[] = [];
    const fieldWrites: {
      facetId: string;
      bool_value?: boolean | null;
      text_value?: string | null;
    }[] = [];
    for (const facet of orderedFacets) {
      const draft = draftFacets.get(facet.id);
      if (!draft) continue;
      switch (draft.kind) {
        case 'enum':
          if (draft.valueIds.length > 0) enumValueIds.push(...draft.valueIds);
          break;
        case 'boolean':
          if (draft.bool !== null) {
            fieldWrites.push({ facetId: facet.id, bool_value: draft.bool, text_value: null });
          }
          break;
        case 'open_text':
          if (draft.text.trim().length > 0) {
            fieldWrites.push({ facetId: facet.id, bool_value: null, text_value: draft.text.trim() });
          }
          break;
      }
    }
    const uniqueEnumIds = [...new Set(enumValueIds)];

    startTransition(async () => {
      try {
        const codeId = await createCode({
          codebookId,
          mnemonic: deriveMnemonic(trimmedName),
          name: trimmedName,
          origin,
          version,
          studyLabel: studyLabel ?? null,
        });

        if (uniqueEnumIds.length > 0) {
          await setCodeFacetValues(codeId, uniqueEnumIds);
        }
        for (const w of fieldWrites) {
          await setCodeFacetField(codeId, w.facetId, {
            bool_value: w.bool_value,
            text_value: w.text_value,
          });
        }

        // Optional label tags: replace-the-set on the just-created code. Skipped
        // entirely when none are chosen (labeling is optional).
        if (selectedLabelIds.size > 0) {
          await setCodeLabels(codeId, [...selectedLabelIds]);
        }

        // Success: clear name / definition / facets / labels; keep origin for next.
        setName('');
        setDefinition('');
        setDraftFacets(new Map());
        setSelectedLabelIds(new Set());
        onCreated?.();
      } catch (err) {
        // Keep the form populated so the researcher can fix + retry.
        setError(err instanceof Error ? err.message : 'Failed to create code.');
      }
    });
  }

  return (
    <section className="rounded border border-foreground/15 p-3">
      <h2 className="mb-2 text-sm font-semibold">New code</h2>

      <div className="space-y-3">
        {/* Name (required) */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-foreground/50">
            Name<span className="text-red-600">*</span>
          </span>
          <input
            type="text"
            value={name}
            disabled={isPending}
            onChange={(e) => setName(e.target.value)}
            placeholder="code name"
            aria-label="Code name"
            className="rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm disabled:opacity-50"
          />
        </label>

        {/* Origin */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-foreground/50">Origin</span>
          <select
            value={origin}
            disabled={isPending}
            onChange={(e) => setOrigin(e.target.value as CodeOrigin)}
            aria-label="Code origin"
            className="rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm disabled:opacity-50"
          >
            {ORIGINS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {/* Definition (optional, one line) */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-foreground/50">
            Definition <span className="normal-case text-foreground/30">(optional)</span>
          </span>
          <input
            type="text"
            value={definition}
            disabled={isPending}
            onChange={(e) => setDefinition(e.target.value)}
            placeholder="one-line definition (defaults to the name)"
            aria-label="Code definition (optional)"
            className="rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm disabled:opacity-50"
          />
        </label>

        {/* One input per facet, rendered by its TYPE. */}
        {orderedFacets.map((facet) => {
          const mode = modeOf(facet);
          const draft = draftFacets.get(facet.id);
          return (
            <div key={facet.id} className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wider text-foreground/50">
                {facet.label}
              </span>

              {mode === 'enum-single' && (
                <select
                  value={draft?.kind === 'enum' ? draft.valueIds[0] ?? '' : ''}
                  disabled={isPending}
                  onChange={(e) =>
                    setFacet(facet.id, {
                      kind: 'enum',
                      valueIds: e.target.value ? [e.target.value] : [],
                    })
                  }
                  aria-label={`${facet.label} value`}
                  className="rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                >
                  <option value="">—</option>
                  {facet.values.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              )}

              {mode === 'enum-multi' && (
                <div className="flex flex-wrap gap-1.5">
                  {facet.values.length === 0 && (
                    <span className="text-xs text-foreground/30">No values on this facet.</span>
                  )}
                  {facet.values.map((v) => {
                    const selected = draft?.kind === 'enum' ? draft.valueIds : [];
                    const isOn = selected.includes(v.id);
                    return (
                      <button
                        key={v.id}
                        type="button"
                        disabled={isPending}
                        aria-pressed={isOn}
                        onClick={() => {
                          const cur = draft?.kind === 'enum' ? draft.valueIds : [];
                          const next = cur.includes(v.id)
                            ? cur.filter((id) => id !== v.id)
                            : [...cur, v.id];
                          setFacet(facet.id, { kind: 'enum', valueIds: next });
                        }}
                        className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs transition disabled:opacity-50 ${
                          isOn
                            ? 'border-foreground bg-foreground text-background'
                            : 'border-foreground/20 hover:border-foreground'
                        }`}
                      >
                        {v.color && (
                          <span
                            className="inline-block h-2 w-2 rounded-sm shrink-0"
                            style={{ backgroundColor: v.color }}
                            aria-hidden
                          />
                        )}
                        {v.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {mode === 'boolean' && (
                <div
                  className="inline-flex w-fit border border-foreground/20"
                  role="radiogroup"
                  aria-label={`${facet.label} yes/no`}
                >
                  {(
                    [
                      { label: 'unset', v: null },
                      { label: 'no', v: false },
                      { label: 'yes', v: true },
                    ] as { label: string; v: boolean | null }[]
                  ).map((o, i) => {
                    const current = draft?.kind === 'boolean' ? draft.bool : null;
                    const isOn = current === o.v;
                    return (
                      <button
                        key={o.label}
                        type="button"
                        role="radio"
                        aria-checked={isOn}
                        disabled={isPending}
                        onClick={() => setFacet(facet.id, { kind: 'boolean', bool: o.v })}
                        className={`px-2 py-0.5 text-xs transition disabled:opacity-50 ${
                          i > 0 ? 'border-l border-foreground/20' : ''
                        } ${isOn ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {mode === 'open-text' && (
                <input
                  type="text"
                  value={draft?.kind === 'open_text' ? draft.text : ''}
                  disabled={isPending}
                  onChange={(e) => setFacet(facet.id, { kind: 'open_text', text: e.target.value })}
                  placeholder="note…"
                  aria-label={`${facet.label} note`}
                  className="rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                />
              )}
            </div>
          );
        })}

        {/* OPTIONAL label tags (themes). Chip toggles, same style as enum-multi
            facets. With no labels yet, a hint links to the Labels manager so the
            affordance is always discoverable — labeling stays optional either way. */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-foreground/50">
            Labels <span className="normal-case text-foreground/30">(optional)</span>
          </span>
          {labels.length === 0 ? (
            <span className="text-xs text-foreground/40">
              No labels yet —{' '}
              <Link href="/labels" className="underline hover:text-foreground">
                create them on the Labels page
              </Link>
              , then tag codes here.
            </span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {labels.map((l) => {
                const isOn = selectedLabelIds.has(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    disabled={isPending}
                    aria-pressed={isOn}
                    onClick={() =>
                      setSelectedLabelIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(l.id)) next.delete(l.id);
                        else next.add(l.id);
                        return next;
                      })
                    }
                    className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs transition disabled:opacity-50 ${
                      isOn
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-foreground/20 hover:border-foreground'
                    }`}
                  >
                    {l.color && (
                      <span
                        className="inline-block h-2 w-2 rounded-sm shrink-0"
                        style={{ backgroundColor: l.color }}
                        aria-hidden
                      />
                    )}
                    {l.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Read-only system field: the session's auto-assigned authoring study. */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-foreground/50">Study</span>
          <input
            type="text"
            value={studyLabel ?? '—'}
            readOnly
            disabled
            aria-label="Study (auto-assigned)"
            className="rounded border border-foreground/15 bg-foreground/5 px-2 py-1 text-sm text-foreground/60"
          />
          <span className="text-xs text-foreground/40">auto-assigned from this session</span>
        </label>

        {/* Submit + inline error */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="rounded bg-foreground px-3 py-1 text-sm text-background transition disabled:opacity-40"
          >
            {isPending ? 'Adding…' : 'Add code'}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </div>
    </section>
  );
}

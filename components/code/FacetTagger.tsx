'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setCodeFacetValues, setCodeFacetField } from '@/app/actions/codes';
import { createFacetValue } from '@/app/actions/facets';
import { linkCitation, unlinkCitation } from '@/app/actions/citations';
import type { FacetWithValues, CodeFacetField } from '@/app/actions/codebook';
import { facetRenderMode, coerceFacetType, slugifyValueKey } from '@/lib/codebook/facet-types';
import type { Tables } from '@/lib/types/cb-db';

type Citation = Tables<'cb_citations'>;

const OTHER = '__other__';

/**
 * Per-code facet classifier. Each real facet renders by its TYPE (migration 22):
 *
 *   - enum single  → a <select> of the facet's values, PLUS an "Other…" entry
 *     that reveals a text input; submitting it adds the value
 *     (createFacetValue) and assigns it — all without leaving for the Scheme
 *     page. Selecting a value replaces any prior value on that facet; "— none —"
 *     clears it.
 *   - enum multi   → the original chip toggles (independent on/off per value).
 *   - boolean      → a three-way yes / no / unset control (cb_code_facet_fields
 *     .bool_value; unset = no row).
 *   - open_text    → a one-line text input, debounced, saved via setCodeFacetField
 *     (cb_code_facet_fields.text_value; empty clears the row).
 *
 * enum value membership writes cb_code_facet_values via setCodeFacetValues
 * (replace-the-whole-set, unchanged); boolean/open_text write
 * cb_code_facet_fields via setCodeFacetField. Both paths are optimistic with a
 * router.refresh() and roll back to server truth on error.
 *
 * Plus a built-in, always-present, OPTIONAL virtual "Citations" facet (NOT a
 * cb_facets row): its options are the codebook's cb_citations and toggling one
 * links/unlinks a cb_code_citations row ('related' role for a hand-link). It
 * reflects ALL existing links regardless of role, so a deductive 'derived_from'
 * link also shows as checked. Empty is the default and fine.
 */
export default function FacetTagger({
  codeId,
  facets,
  selectedValueIds,
  facetFields,
  citations,
  linkedCitationIds,
}: {
  codeId: string;
  facets: FacetWithValues[];
  selectedValueIds: string[];
  facetFields: CodeFacetField[];
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

  // Per-facet field map (boolean / open_text), keyed by facetId, seeded from
  // server. The enum path uses `selected`; this holds the valueless-facet data.
  const [fields, setFields] = useState<Map<string, CodeFacetField>>(
    () => new Map(facetFields.map((f) => [f.facetId, f])),
  );

  function fieldFor(facetId: string): CodeFacetField | undefined {
    return fields.get(facetId);
  }

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

  /** enum-multi: independent on/off per value. */
  function toggleMulti(valueId: string) {
    const next = new Set(selected);
    if (next.has(valueId)) next.delete(valueId);
    else next.add(valueId);
    commit(next);
  }

  /** enum-single: replace this facet's value with `valueId` (or clear if ''). */
  function pickSingle(facet: FacetWithValues, valueId: string) {
    const next = new Set(selected);
    for (const v of facet.values) next.delete(v.id);
    if (valueId) next.add(valueId);
    commit(next);
  }

  /** "Other…" (enum): create the value on the facet, then assign it (single =
   *  replace this facet's value; multi = add). Optimism is deferred to the
   *  refresh because the new value id isn't known until the insert returns. */
  function addOther(facet: FacetWithValues, label: string, single: boolean) {
    const trimmed = label.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      try {
        const value = await createFacetValue(facet.id, {
          key: slugifyValueKey(trimmed),
          label: trimmed,
        });
        const next = new Set(selected);
        if (single) for (const v of facet.values) next.delete(v.id);
        next.add(value.id);
        await setCodeFacetValues(codeId, [...next]);
        setSelected(next);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add value.');
        setSelected(new Set(selectedValueIds));
      }
    });
  }

  /** boolean / open_text: write the per-facet field (null/empty clears). */
  function commitField(facetId: string, patch: { bool_value?: boolean | null; text_value?: string | null }) {
    setError(null);
    // Optimistically update local field state.
    setFields((prev) => {
      const nextMap = new Map(prev);
      const boolGiven = patch.bool_value !== undefined && patch.bool_value !== null;
      const textTrim = patch.text_value == null ? null : patch.text_value.trim() || null;
      if (!boolGiven && textTrim === null) {
        nextMap.delete(facetId);
      } else {
        nextMap.set(facetId, {
          facetId,
          boolValue: boolGiven ? patch.bool_value! : null,
          textValue: textTrim,
        });
      }
      return nextMap;
    });
    startTransition(async () => {
      try {
        await setCodeFacetField(codeId, facetId, patch);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save field.');
        setFields(new Map(facetFields.map((f) => [f.facetId, f]))); // roll back
      }
    });
  }

  /**
   * Toggle a citation link on this code (the virtual Citations facet). Multi
   * semantics; optimistic flip, write link/unlink, refresh; roll back on error.
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
        facets.map((facet) => {
          // facet.type / facet.cardinality are raw string columns; coerce to the
          // unions before deciding the render mode (forward-compatible + null-safe).
          const mode = facetRenderMode(
            coerceFacetType(facet.type),
            facet.cardinality === 'multi' ? 'multi' : 'single',
          );
          return (
            <fieldset key={facet.id} className="space-y-1.5">
              <legend className="text-xs uppercase tracking-wider text-foreground/50">
                {facet.label}{' '}
                <span className="text-foreground/30 normal-case">
                  ({mode === 'open-text'
                    ? 'open response'
                    : mode === 'boolean'
                      ? 'yes/no'
                      : facet.cardinality})
                </span>
              </legend>

              {mode === 'enum-single' && (
                <EnumSingle
                  facet={facet}
                  selected={selected}
                  disabled={isPending}
                  onPick={(valueId) => pickSingle(facet, valueId)}
                  onAddOther={(label) => addOther(facet, label, true)}
                />
              )}

              {mode === 'enum-multi' && (
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
                        onClick={() => toggleMulti(value.id)}
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
                  <AddOther disabled={isPending} onAdd={(label) => addOther(facet, label, false)} />
                </div>
              )}

              {mode === 'boolean' && (
                <BooleanField
                  value={fieldFor(facet.id)?.boolValue ?? null}
                  disabled={isPending}
                  onChange={(b) => commitField(facet.id, { bool_value: b })}
                />
              )}

              {mode === 'open-text' && (
                <OpenTextField
                  value={fieldFor(facet.id)?.textValue ?? ''}
                  disabled={isPending}
                  onCommit={(text) => commitField(facet.id, { text_value: text })}
                />
              )}
            </fieldset>
          );
        })
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

/** enum-single: a <select> of the facet's values + an "Other…" sentinel that
 *  reveals an inline add-and-assign text input. */
function EnumSingle({
  facet,
  selected,
  disabled,
  onPick,
  onAddOther,
}: {
  facet: FacetWithValues;
  selected: Set<string>;
  disabled: boolean;
  onPick: (valueId: string) => void;
  onAddOther: (label: string) => void;
}) {
  const current = facet.values.find((v) => selected.has(v.id))?.id ?? '';
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={adding ? OTHER : current}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OTHER) {
            setAdding(true);
          } else {
            setAdding(false);
            onPick(v);
          }
        }}
        aria-label={`${facet.label} value`}
        className="border border-foreground/15 px-2 py-1 text-sm bg-background"
      >
        <option value="">— none —</option>
        {facet.values.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {adding && (
        <InlineOtherInput
          disabled={disabled}
          onSubmit={(label) => {
            onAddOther(label);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/** A chip-style "Other…" button (enum-multi) that toggles an inline text input. */
function AddOther({ disabled, onAdd }: { disabled: boolean; onAdd: (label: string) => void }) {
  const [adding, setAdding] = useState(false);
  if (!adding) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setAdding(true)}
        className="inline-flex items-center border border-dashed border-foreground/30 px-2 py-0.5 text-xs hover:border-foreground transition disabled:opacity-50"
      >
        + Other…
      </button>
    );
  }
  return (
    <InlineOtherInput
      disabled={disabled}
      onSubmit={(label) => {
        onAdd(label);
        setAdding(false);
      }}
      onCancel={() => setAdding(false)}
    />
  );
}

/** Shared inline "type a new value name" input. Enter submits, Escape cancels. */
function InlineOtherInput({
  disabled,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  onSubmit: (label: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        value={text}
        disabled={disabled}
        placeholder="new value…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (text.trim()) onSubmit(text);
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        aria-label="New value name"
        className="border border-foreground/15 px-2 py-0.5 text-xs bg-background"
      />
      <button
        type="button"
        disabled={disabled || !text.trim()}
        onClick={() => onSubmit(text)}
        className="border border-foreground/30 px-1.5 py-0.5 text-xs hover:bg-foreground hover:text-background transition disabled:opacity-50"
      >
        add
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onCancel}
        className="text-xs text-foreground/40 hover:text-foreground disabled:opacity-50"
      >
        ×
      </button>
    </span>
  );
}

/** boolean: a three-way yes / no / unset toggle. `unset` clears the field. */
function BooleanField({
  value,
  disabled,
  onChange,
}: {
  value: boolean | null;
  disabled: boolean;
  onChange: (b: boolean | null) => void;
}) {
  const opts: { label: string; v: boolean | null }[] = [
    { label: 'unset', v: null },
    { label: 'no', v: false },
    { label: 'yes', v: true },
  ];
  return (
    <div className="inline-flex border border-foreground/20" role="radiogroup" aria-label="yes/no">
      {opts.map((o, i) => {
        const isOn = value === o.v;
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={isOn}
            disabled={disabled}
            onClick={() => onChange(o.v)}
            className={`px-2 py-0.5 text-xs transition disabled:opacity-50 ${
              i > 0 ? 'border-l border-foreground/20' : ''
            } ${isOn ? 'bg-foreground text-background' : 'hover:bg-foreground/10'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** open_text: a one-line input, debounced (600ms) + commit-on-blur. */
function OpenTextField({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef(value);

  // Re-seed from server truth when it changes (e.g. after refresh / rollback),
  // but only when the field isn't mid-edit relative to what we last saved.
  useEffect(() => {
    if (value !== lastSaved.current) {
      lastSaved.current = value;
      setText(value);
    }
  }, [value]);

  function scheduleSave(next: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next !== lastSaved.current) {
        lastSaved.current = next;
        onCommit(next);
      }
    }, 600);
  }

  function flush(next: string) {
    if (timer.current) clearTimeout(timer.current);
    if (next !== lastSaved.current) {
      lastSaved.current = next;
      onCommit(next);
    }
  }

  return (
    <input
      value={text}
      disabled={disabled}
      placeholder="note…"
      onChange={(e) => {
        setText(e.target.value);
        scheduleSave(e.target.value);
      }}
      onBlur={(e) => flush(e.target.value)}
      aria-label="Open response"
      className="w-full max-w-md border border-foreground/15 px-2 py-1 text-sm bg-background"
    />
  );
}

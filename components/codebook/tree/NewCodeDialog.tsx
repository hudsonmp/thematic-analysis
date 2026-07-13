'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  addCodeFacetValue,
  createCodeInTree,
  type CodeOrigin,
} from '@/app/actions/codes';
import { createFacetValue } from '@/app/actions/facets';
import type { FacetWithValues } from '@/app/actions/codebook';
import { searchCodes } from '@/lib/codebook/codePicker';
import type { Tables } from '@/lib/types/cb-db';

type Code = Tables<'cb_codes'>;

/** New code · an existing code answers this · a nested sub-value. */
type Kind = 'code' | 'existing' | 'subvalue';

/**
 * WHERE the dialog was opened from. This decides which kinds are even offered, and
 * it is why the three `+` buttons are NOT interchangeable:
 *
 *   child    — a VALUE's `+`. All three: author a new code that answers this value,
 *              say an EXISTING code answers it (which may make the code cross-cut),
 *              or add a nested sub-value (a finer answer).
 *   root     — the header `+`. A new TOP-LEVEL value of this dimension.
 *   floating — the corner `+`. A code with NO answers, saved for triage. "Existing
 *              code" is meaningless here: there is no value to answer.
 */
export type DialogTarget =
  | { kind: 'child'; id: string; name: string }
  | { kind: 'root' }
  | { kind: 'floating' };

/**
 * The dialog behind a `+`.
 *
 * The model it serves:
 *   FACET (dimension) — a question askable of every code.
 *   VALUE  — an answer. Values nest.
 *   CODE   — the only thing applied to data. It ANSWERS values, and may answer two
 *            on one dimension (the cross-cutting case) without being duplicated.
 *
 * A new code's fields are its ANATOMY (mnemonic, name, definition — first-class,
 * versioned columns on cb_code_versions) plus its ANSWERS on every declared
 * dimension. The dialog invents no fields: the dimensions come from the codebook.
 *
 * ORIGIN defaults to `a_priori` under a pinned paper but is never forced — "came from
 * a paper" and "is a priori" are different claims, and a code drawn from a paper can
 * still be emergent from pilot data.
 */
export default function NewCodeDialog({
  codebookId,
  facetId,
  target,
  facets,
  codes,
  nodeNameById,
  pinnedCitationId,
  onClose,
  onDone,
}: {
  codebookId: string;
  /** The dimension whose value chain the canvas is showing. */
  facetId: string;
  target: DialogTarget;
  /** Every dimension — a new code answers all of them, not just the one on screen. */
  facets: FacetWithValues[];
  /** Every code — so the dialog can name an EXISTING one, not only author a new one. */
  codes: (Pick<Code, 'id' | 'mnemonic' | 'name'> & { facetValueIds: string[] })[];
  nodeNameById: ReadonlyMap<string, string>;
  pinnedCitationId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const parentValueId = target.kind === 'child' ? target.id : null;
  const parentName = target.kind === 'child' ? target.name : null;

  const [kind, setKind] = useState<Kind>(target.kind === 'root' ? 'subvalue' : 'code');
  const [query, setQuery] = useState('');

  const [mnemonic, setMnemonic] = useState('');
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState('');
  const [origin, setOrigin] = useState<CodeOrigin>(
    pinnedCitationId !== null ? 'a_priori' : 'emergent',
  );

  // facetId → the value ids this new code answers on that dimension. An ARRAY, not a
  // scalar: a `multi` dimension is exactly what lets a cross-cutting code give two
  // answers instead of being duplicated into two branches.
  const [answers, setAnswers] = useState<Record<string, string[]>>(() =>
    parentValueId !== null ? { [facetId]: [parentValueId] } : {},
  );

  const [valueLabel, setValueLabel] = useState('');
  const [valueDescription, setValueDescription] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const hits = useMemo(
    () =>
      kind === 'existing'
        ? searchCodes(
            codes.map((c) => ({ ...c, labelIds: c.facetValueIds })),
            query,
            parentValueId,
            nodeNameById,
          )
        : [],
    [kind, codes, query, parentValueId, nodeNameById],
  );

  function toggleAnswer(fid: string, valueId: string, multi: boolean) {
    setAnswers((s) => {
      const current = s[fid] ?? [];
      if (current.includes(valueId)) {
        return { ...s, [fid]: current.filter((v) => v !== valueId) };
      }
      // A `single`-cardinality dimension admits exactly one answer, so a new pick
      // REPLACES rather than accumulates. Enforced here because the dialog is the
      // only place that knows the facet.
      return { ...s, [fid]: multi ? [...current, valueId] : [valueId] };
    });
  }

  /** An EXISTING code answers this value. May make it cross-cut — deliberately; the
   *  row said so before it was clicked. */
  function attachExisting(codeId: string) {
    if (parentValueId === null) return;
    setError(null);
    start(async () => {
      try {
        await addCodeFacetValue(codeId, parentValueId);
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to record the answer.');
      }
    });
  }

  function submit() {
    setError(null);
    start(async () => {
      try {
        if (kind === 'subvalue') {
          const trimmed = valueLabel.trim();
          if (!trimmed) {
            setError('A value needs a name.');
            return;
          }
          await createFacetValue(facetId, {
            // The key is never shown and must be unique within the facet; a slug of
            // the label would collide the moment two branches use the same word.
            key: crypto.randomUUID(),
            label: trimmed,
            description: valueDescription.trim() || undefined,
            parentId: parentValueId,
          });
        } else {
          if (!mnemonic.trim() || !name.trim() || !definition.trim()) {
            setError('A code needs a mnemonic, a name, and a definition.');
            return;
          }
          const codeId = await createCodeInTree({
            codebookId,
            mnemonic: mnemonic.trim(),
            name: name.trim(),
            origin,
            version: {
              definition: definition.trim(),
              include_if: [],
              exclude_if: [],
              exemplars: [],
            },
            // The tree placement is gone: a code's home IS its answers.
            labelId: null,
            citationId: pinnedCitationId,
          });

          // Answers are written AFTER the code exists, and ADDITIVELY — never through
          // setCodeFacetValues, which is a delete-all-then-insert across ALL
          // dimensions. A failure here leaves a real code with a missing answer (it
          // simply appears in the triage queue), not a half-created one.
          for (const valueIds of Object.values(answers)) {
            for (const valueId of valueIds) await addCodeFacetValue(codeId, valueId);
          }
        }
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create.');
      }
    });
  }

  const title =
    kind === 'existing'
      ? 'An existing code answers this'
      : kind === 'code'
        ? 'New code'
        : target.kind === 'root'
          ? 'New value'
          : 'New sub-value';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg border border-foreground/20 bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between border-b border-foreground/15 px-4 py-3">
          <h2 className="text-sm font-medium tracking-tight">
            {title}
            {parentName ? (
              <span className="font-normal text-foreground/50"> under {parentName}</span>
            ) : (
              target.kind === 'floating' && (
                <span className="font-normal text-foreground/50">
                  {' '}
                  · unclassified, triage later
                </span>
              )
            )}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-foreground/50 hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">
          {target.kind === 'child' && (
            <div className="flex gap-1 text-xs">
              {(['code', 'existing', 'subvalue'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`border px-3 py-1.5 transition ${
                    kind === k
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-foreground/20 text-foreground/60 hover:border-foreground/50'
                  }`}
                >
                  {k === 'code'
                    ? 'New code'
                    : k === 'existing'
                      ? 'Existing code'
                      : 'Sub-value'}
                </button>
              ))}
            </div>
          )}

          {kind === 'existing' ? (
            <>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search all codes…"
                className={inputCls}
              />
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {hits.length === 0 && (
                  <p className="py-2 text-xs italic text-foreground/40">No code matches.</p>
                )}
                {hits.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    disabled={h.status === 'here' || pending}
                    onClick={() => attachExisting(h.id)}
                    className={`w-full border px-2 py-1.5 text-left text-xs transition ${
                      h.status === 'here'
                        ? 'cursor-default border-transparent text-foreground/30'
                        : 'border-transparent hover:border-foreground/30 hover:bg-foreground/[0.03]'
                    }`}
                  >
                    <span className="font-mono">{h.mnemonic}</span>{' '}
                    <span className="text-foreground/60">{h.name}</span>
                    {h.status === 'here' && (
                      <span className="ml-1 text-foreground/30">· already answers this</span>
                    )}
                    {h.status === 'elsewhere' && (
                      <span className="ml-1 text-foreground/45">
                        · also answers {h.otherNodes.join(', ')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          ) : kind === 'subvalue' ? (
            <>
              <Field label="Name">
                <input
                  autoFocus
                  value={valueLabel}
                  onChange={(e) => setValueLabel(e.target.value)}
                  className={inputCls}
                  placeholder="e.g. Evidence evaluation"
                />
              </Field>
              <Field label="Description">
                <textarea
                  value={valueDescription}
                  onChange={(e) => setValueDescription(e.target.value)}
                  rows={3}
                  className={inputCls}
                  placeholder="What does this answer cover — and what does it deliberately not?"
                />
              </Field>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[7rem_1fr] gap-3">
                <Field label="Mnemonic">
                  <input
                    autoFocus
                    value={mnemonic}
                    onChange={(e) => setMnemonic(e.target.value)}
                    className={inputCls}
                    placeholder="CONF"
                  />
                </Field>
                <Field label="Name">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputCls}
                    placeholder="Confirmation bias in review"
                  />
                </Field>
              </div>

              <Field label="Definition">
                <textarea
                  value={definition}
                  onChange={(e) => setDefinition(e.target.value)}
                  rows={3}
                  className={inputCls}
                />
              </Field>

              <Field label="Origin">
                <div className="flex gap-1 text-xs">
                  {(['a_priori', 'pilot', 'emergent'] as const).map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => setOrigin(o)}
                      className={`border px-2.5 py-1 transition ${
                        origin === o
                          ? 'border-foreground bg-foreground text-background'
                          : 'border-foreground/20 text-foreground/60 hover:border-foreground/50'
                      }`}
                    >
                      {o.replace('_', ' ')}
                    </button>
                  ))}
                </div>
              </Field>

              {/* THE ANSWERS. One block per dimension, rendered from the codebook's own
                  facets — the dialog invents no fields. Leaving a dimension blank is
                  allowed: the code lands in the triage queue, which is the point of
                  letting a code exist before it has been classified. */}
              {facets.length === 0 ? (
                <p className="text-xs italic text-foreground/45">
                  No dimensions declared yet. This code will be created unclassified.
                </p>
              ) : (
                facets.map((f) => {
                  const multi = f.cardinality === 'multi';
                  const mine = answers[f.id] ?? [];
                  return (
                    <Field
                      key={f.id}
                      label={f.label}
                      hint={multi ? 'more than one answer allowed' : undefined}
                    >
                      <div className="flex flex-wrap gap-1">
                        {f.values.map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => toggleAnswer(f.id, v.id, multi)}
                            className={`border px-2 py-1 text-xs transition ${
                              mine.includes(v.id)
                                ? 'border-foreground bg-foreground text-background'
                                : 'border-foreground/20 text-foreground/60 hover:border-foreground/50'
                            }`}
                          >
                            {v.label}
                          </button>
                        ))}
                        {f.values.length === 0 && (
                          <span className="text-xs italic text-foreground/40">
                            no values yet
                          </span>
                        )}
                      </div>
                    </Field>
                  );
                })
              )}
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-foreground/15 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-foreground/60 hover:text-foreground"
          >
            Cancel
          </button>
          {/* Browsing existing codes commits on the ROW click, so a Continue button
              here would have nothing to submit. */}
          {kind !== 'existing' && (
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="border border-foreground bg-foreground px-4 py-1.5 text-sm text-background transition hover:opacity-90 disabled:opacity-40"
            >
              {pending ? 'Creating…' : 'Continue'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full border border-foreground/20 bg-background px-2 py-1.5 text-sm focus:border-foreground focus:outline-none';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium tracking-tight text-foreground/80">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-snug text-foreground/45">{hint}</p>}
    </div>
  );
}

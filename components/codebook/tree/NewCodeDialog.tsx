'use client';

import { useState, useTransition } from 'react';
import {
  createCodeInTree,
  setCodeFacetField,
  setCodeFacetValues,
} from '@/app/actions/codes';
import { createLabel, setLabelNote } from '@/app/actions/labels';
import type { FacetWithValues } from '@/app/actions/codebook';
import type { CodeOrigin } from '@/app/actions/codes';

/**
 * The dialog behind a node's `+`. It asks WHICH KIND of child, because the tree
 * holds two:
 *
 *   CODE — the thing applied to data. Fill in the SCHEME: the codebook's own
 *          facets (defined on the Scheme page — this dialog does not invent
 *          fields, it renders whatever the researcher declared) plus the
 *          definition every code must have.
 *   NODE — a construct/folder. Never applied to data, so it has no scheme; it
 *          carries a NOTE instead: why this grouping exists, what it gathers.
 *
 * Asking is the honest move. A `+` that always made a code would force every
 * intermediate construct to masquerade as an applicable code — which is exactly
 * the conflation that makes hierarchical codebooks un-κ-able.
 *
 * ORIGIN defaults to `a_priori` when a paper is pinned, but is NOT forced: "came
 * from a paper" and "is a priori" are different claims — a code inspired by a
 * paper can still be `emergent` from pilot data. The pin sets the citation; the
 * researcher still owns the origin.
 */
export default function NewCodeDialog({
  codebookId,
  parentId,
  parentName,
  facets,
  pinnedCitationId,
  onClose,
  onDone,
}: {
  codebookId: string;
  /** The node whose `+` was clicked. `null` = a new ROOT (the top-of-screen `+`). */
  parentId: string | null;
  parentName: string | null;
  facets: FacetWithValues[];
  /** Deductive-mode pin. When set, a new code auto-links this citation. */
  pinnedCitationId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  // A new ROOT is always a node: a root code with no construct above it would be
  // a code pretending to be a tree, so the kind switch is hidden at the top level.
  const [kind, setKind] = useState<'code' | 'node'>(parentId === null ? 'node' : 'code');

  const [mnemonic, setMnemonic] = useState('');
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState('');
  const [origin, setOrigin] = useState<CodeOrigin>(
    pinnedCitationId !== null ? 'a_priori' : 'emergent',
  );
  // facetId → chosen value id (enum) / boolean / free text.
  const [enumChoice, setEnumChoice] = useState<Record<string, string>>({});
  const [boolChoice, setBoolChoice] = useState<Record<string, boolean>>({});
  const [textChoice, setTextChoice] = useState<Record<string, string>>({});

  const [nodeNote, setNodeNote] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        if (kind === 'node') {
          const trimmed = name.trim();
          if (!trimmed) {
            setError('A node needs a name.');
            return;
          }
          const created = await createLabel(codebookId, { name: trimmed, parentId });
          // The note is a separate write, and only when non-empty: createLabel does
          // not take one, and an empty note must stay NULL rather than ''.
          if (nodeNote.trim()) await setLabelNote(created.id, nodeNote);
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
            labelId: parentId,
            citationId: pinnedCitationId,
          });

          // Enum facets go to cb_code_facet_values; boolean/open_text to
          // cb_code_facet_fields. Both are set AFTER creation — the code exists
          // either way, so a facet write that fails leaves a real code with a
          // missing facet, not a half-created one.
          const chosen = Object.values(enumChoice).filter(Boolean);
          if (chosen.length > 0) await setCodeFacetValues(codeId, chosen);
          for (const [facetId, v] of Object.entries(boolChoice)) {
            if (v) await setCodeFacetField(codeId, facetId, { bool_value: true });
          }
          for (const [facetId, v] of Object.entries(textChoice)) {
            if (v.trim()) await setCodeFacetField(codeId, facetId, { text_value: v.trim() });
          }
        }
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create.');
      }
    });
  }

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
            {kind === 'code' ? 'New code' : 'New node'}
            {parentName && (
              <span className="text-foreground/50 font-normal"> under {parentName}</span>
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

        <div className="max-h-[70vh] overflow-y-auto px-4 py-4 space-y-4">
          {parentId !== null && (
            <div className="flex gap-1 text-xs">
              {(['code', 'node'] as const).map((k) => (
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
                  {k === 'code' ? 'Code (applied to data)' : 'Node (a grouping)'}
                </button>
              ))}
            </div>
          )}

          {kind === 'node' ? (
            <>
              <Field label="Name">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputCls}
                  placeholder="e.g. Impasse"
                />
              </Field>
              <Field
                label="Note"
                hint="A node is never applied to data, so it has no scheme. Say why this grouping exists and what it does — and does not — gather."
              >
                <textarea
                  value={nodeNote}
                  onChange={(e) => setNodeNote(e.target.value)}
                  rows={3}
                  className={inputCls}
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
                    placeholder="AMB"
                  />
                </Field>
                <Field label="Name">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputCls}
                    placeholder="Ambiguity unresolved"
                  />
                </Field>
              </div>

              <Field label="Definition" hint="What must be true of a segment for this code to apply.">
                <textarea
                  value={definition}
                  onChange={(e) => setDefinition(e.target.value)}
                  rows={3}
                  className={inputCls}
                />
              </Field>

              <Field
                label="Origin"
                hint={
                  pinnedCitationId !== null
                    ? 'A pinned paper defaults this to a priori — but a code drawn from a paper can still be emergent from pilot data. Yours to set.'
                    : undefined
                }
              >
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

              {/* THE SCHEME. Rendered from the codebook's own cb_facets — this
                  dialog invents no fields. An empty scheme is not an error: it
                  means the researcher has not declared facets yet. */}
              {facets.length === 0 ? (
                <p className="text-xs text-foreground/45 italic">
                  No facets defined yet — the scheme is empty. Declare facets on the
                  Scheme page and they will appear here.
                </p>
              ) : (
                facets.map((f) => (
                  <Field key={f.id} label={f.label} hint={f.description ?? undefined}>
                    {f.type === 'enum' ? (
                      <select
                        value={enumChoice[f.id] ?? ''}
                        onChange={(e) =>
                          setEnumChoice((s) => ({ ...s, [f.id]: e.target.value }))
                        }
                        className={inputCls}
                      >
                        <option value="">—</option>
                        {f.values.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    ) : f.type === 'boolean' ? (
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={boolChoice[f.id] ?? false}
                          onChange={(e) =>
                            setBoolChoice((s) => ({ ...s, [f.id]: e.target.checked }))
                          }
                        />
                        <span className="text-foreground/70">yes</span>
                      </label>
                    ) : (
                      <input
                        value={textChoice[f.id] ?? ''}
                        onChange={(e) =>
                          setTextChoice((s) => ({ ...s, [f.id]: e.target.value }))
                        }
                        className={inputCls}
                      />
                    )}
                  </Field>
                ))
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
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="border border-foreground bg-foreground px-4 py-1.5 text-sm text-background transition hover:opacity-90 disabled:opacity-40"
          >
            {pending ? 'Creating…' : 'Continue'}
          </button>
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

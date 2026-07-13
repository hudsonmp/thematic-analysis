'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  createCodeInTree,
  setCodeFacetField,
  setCodeFacetValues,
} from '@/app/actions/codes';
import { attachCodeToLabel, createLabel, setLabelNote } from '@/app/actions/labels';
import type { FacetWithValues } from '@/app/actions/codebook';
import type { CodeOrigin } from '@/app/actions/codes';
import { searchCodes } from '@/lib/codebook/codePicker';
import type { Tables } from '@/lib/types/cb-db';

type Code = Tables<'cb_codes'>;

/** New code · attach an existing code · new child node. */
type Kind = 'code' | 'existing' | 'node';

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
/**
 * WHERE the dialog was opened from. This decides which kinds of child are even
 * offered, and it is the reason the `+` buttons are not interchangeable:
 *
 *   child    — a node's `+`. All three: a new code, an EXISTING code (which may
 *              make a duplicate), or a child node.
 *   root     — the header `+`. A node only: a root code with no construct above it
 *              would be a code pretending to be a tree.
 *   floating — the corner `+`. A new code with NO home, saved for later. "Existing
 *              code" is meaningless here: there is nothing to attach it TO.
 */
export type DialogTarget =
  | { kind: 'child'; id: string; name: string }
  | { kind: 'root' }
  | { kind: 'floating' };

export default function NewCodeDialog({
  codebookId,
  target,
  facets,
  codes,
  nodeNameById,
  pinnedCitationId,
  onClose,
  onDone,
}: {
  codebookId: string;
  target: DialogTarget;
  facets: FacetWithValues[];
  /** Every code — so the dialog can offer an EXISTING one, not only a new one. */
  codes: (Pick<Code, 'id' | 'mnemonic' | 'name'> & { labelIds: string[] })[];
  nodeNameById: ReadonlyMap<string, string>;
  /** Deductive-mode pin. When set, a new code auto-links this citation. */
  pinnedCitationId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const parentId = target.kind === 'child' ? target.id : null;
  const parentName = target.kind === 'child' ? target.name : null;

  const [kind, setKind] = useState<Kind>(target.kind === 'root' ? 'node' : 'code');
  const [query, setQuery] = useState('');

  const hits = useMemo(
    () => (kind === 'existing' ? searchCodes(codes, query, parentId, nodeNameById) : []),
    [kind, codes, query, parentId, nodeNameById],
  );

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

  /** Attach an EXISTING code to this node. May create a duplicate — deliberately;
   *  the row said so before it was clicked. */
  function attach(codeId: string) {
    if (parentId === null) return; // 'existing' is never offered without a target
    setError(null);
    start(async () => {
      try {
        await attachCodeToLabel(codeId, parentId);
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to place the code.');
      }
    });
  }

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
            {kind === 'existing'
              ? 'Place an existing code'
              : kind === 'code'
                ? 'New code'
                : 'New node'}
            {parentName ? (
              <span className="font-normal text-foreground/50"> under {parentName}</span>
            ) : (
              target.kind === 'floating' && (
                <span className="font-normal text-foreground/50">
                  {' '}
                  · floating, no home yet
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

        <div className="max-h-[70vh] overflow-y-auto px-4 py-4 space-y-4">
          {/* Three intents behind ONE `+`, offered only where each makes sense.
              'existing' needs a node to attach to, so it is absent on the corner
              (floating) `+` and on the root `+`. */}
          {target.kind === 'child' && (
            <div className="flex gap-1 text-xs">
              {(['code', 'existing', 'node'] as const).map((k) => (
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
                      : 'Node (a grouping)'}
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
                    onClick={() => attach(h.id)}
                    className={`w-full border px-2 py-1.5 text-left text-xs transition ${
                      h.status === 'here'
                        ? 'cursor-default border-transparent text-foreground/30'
                        : 'border-transparent hover:border-foreground/30 hover:bg-foreground/[0.03]'
                    }`}
                  >
                    <span className="font-mono">{h.mnemonic}</span>{' '}
                    <span className="text-foreground/60">{h.name}</span>
                    {h.status === 'here' && (
                      <span className="ml-1 text-foreground/30">· already here</span>
                    )}
                    {h.status === 'elsewhere' && (
                      // The duplicate is named BEFORE it is made. A second placement
                      // is legitimate — it just must never be a surprise.
                      <span className="ml-1 text-amber-700 dark:text-amber-500">
                        · duplicate of {h.otherNodes.join(', ')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          ) : kind === 'node' ? (
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

              <Field label="Definition">
                <textarea
                  value={definition}
                  onChange={(e) => setDefinition(e.target.value)}
                  rows={3}
                  className={inputCls}
                />
              </Field>

              {/* Origin still DEFAULTS to a_priori under a pinned paper and is still
                  not forced — the reasoning lives in the action's docs, not as a
                  paragraph the researcher re-reads on every single code. */}
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

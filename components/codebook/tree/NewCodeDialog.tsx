'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  addCodeFacetValue,
  createCodeInTree,
  type CodeOrigin,
} from '@/app/actions/codes';
import { createFacetValue, setFacetValueParent } from '@/app/actions/facets';
import { descendantIds } from '@/lib/codebook/tree';
import type { FacetWithValues } from '@/app/actions/codebook';
import { searchCodes } from '@/lib/codebook/codePicker';
import { normalizeSlug } from '@/lib/codebook/mnemonic';
import BulletListEditor from '@/components/code/BulletListEditor';
import ValueList from './ValueList';
import type { Tables } from '@/lib/types/cb-db';

type Code = Tables<'cb_codes'>;

/** New code · an existing code answers this · a new sub-value · an EXISTING value moved
 *  under this one. */
type Kind = 'code' | 'existing' | 'subvalue' | 'existing-value';

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
 * A new code's fields are its ANATOMY (the slug/mnemonic — its sole identifier,
 * typed directly — plus the definition, versioned on cb_code_versions) plus its
 * ANSWERS on every declared dimension. The dialog invents no fields: the
 * dimensions come from the codebook.
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
  codes: (Pick<Code, 'id' | 'mnemonic'> & { facetValueIds: string[] })[];
  nodeNameById: ReadonlyMap<string, string>;
  pinnedCitationId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const parentValueId = target.kind === 'child' ? target.id : null;
  const parentName = target.kind === 'child' ? target.name : null;

  const [kind, setKind] = useState<Kind>(target.kind === 'root' ? 'subvalue' : 'code');
  const [query, setQuery] = useState('');

  // The SLUG the researcher types IS the mnemonic (the code's sole identifier).
  const [slug, setSlug] = useState('');

  // The ANATOMY — first-class, versioned columns on cb_code_versions. These used to
  // be faked as valueless open_text "facets", which meant include_if lived in two
  // places with nothing syncing them. They belong here.
  const [definition, setDefinition] = useState('');
  const [includeIf, setIncludeIf] = useState<string[]>([]);
  const [excludeIf, setExcludeIf] = useState<string[]>([]);
  const [exemplars, setExemplars] = useState<string[]>([]);
  const [disconfirming, setDisconfirming] = useState('');

  // A pinned paper means a priori: a code you are deriving from a source IS
  // theory-derived. `originTouched` lets the researcher override afterwards without
  // the pin snapping it back on the next render.
  const [originTouched, setOriginTouched] = useState(false);
  const [originChoice, setOriginChoice] = useState<CodeOrigin>('emergent');
  const origin: CodeOrigin = originTouched
    ? originChoice
    : pinnedCitationId !== null
      ? 'a_priori'
      : 'emergent';

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

  /** The normalized slug (UPPER-KEBAB) that will actually be saved as the mnemonic.
   *  Shown live under the input so the researcher sees the canonical form before
   *  committing, and used to check the uniqueness of the typed slug. */
  const normalizedSlug = useMemo(() => (slug.trim() ? normalizeSlug(slug.trim()) : ''), [slug]);
  const slugTaken = useMemo(
    () => normalizedSlug !== '' && codes.some((c) => c.mnemonic === normalizedSlug),
    [normalizedSlug, codes],
  );

  /**
   * Candidate values to MOVE under this node. Excludes the node itself and every
   * DESCENDANT of it — re-parenting a value under its own descendant would close a cycle.
   * The server rejects that anyway, but offering a choice that always errors is a lie the
   * UI is telling.
   *
   * Note this MOVES the value (with its whole sub-chain and every code answering it), it
   * does not copy it. To have the same answer in two places, duplicate first (⌘D) — and
   * read the warning there, because two identically-named values in one dimension is an
   * answer set a coder cannot disambiguate.
   */
  const valueHits = useMemo(() => {
    if (kind !== 'existing-value' || parentValueId === null) return [];
    const all = facets.find((f) => f.id === facetId)?.values ?? [];
    const banned = descendantIds(all, parentValueId);
    banned.add(parentValueId);
    const q = query.trim().toLowerCase();
    return all
      .filter((v) => !banned.has(v.id))
      .filter((v) => q === '' || v.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [kind, parentValueId, facets, facetId, query]);

  function moveValueHere(valueId: string) {
    if (parentValueId === null) return;
    setError(null);
    start(async () => {
      try {
        await setFacetValueParent(valueId, parentValueId);
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to move the value.');
      }
    });
  }

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
          if (!slug.trim() || !definition.trim()) {
            setError('A code needs a slug and a definition.');
            return;
          }
          // The typed slug IS the mnemonic (the code's sole identifier). Normalize
          // it to the canonical UPPER-KEBAB form and reject a collision outright —
          // cb_codes has UNIQUE(codebook_id, mnemonic), and silently auto-suffixing
          // a hand-typed slug would hide a naming decision the researcher must make.
          const resolvedMnemonic = normalizeSlug(slug.trim());
          if (codes.some((c) => c.mnemonic === resolvedMnemonic)) {
            setError(`The slug "${resolvedMnemonic}" is already in use.`);
            return;
          }

          const codeId = await createCodeInTree({
            codebookId,
            mnemonic: resolvedMnemonic,
            origin,
            version: {
              definition: definition.trim(),
              include_if: includeIf,
              exclude_if: excludeIf,
              // Exemplars carry an optional pid/episode; captured as plain text here
              // and enriched later in the full anatomy editor. An exemplar with no
              // provenance is still worth more than no exemplar.
              exemplars: exemplars.map((text) => ({ text })),
              // Prediction/falsifier are no longer authored in the UI. The DB
              // columns stay; a NEW code simply starts without them.
              disconfirming_pattern: disconfirming.trim() || undefined,
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
      : kind === 'existing-value'
        ? 'Move an existing value here'
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
              {(['code', 'existing', 'subvalue', 'existing-value'] as const).map((k) => (
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
                      : k === 'subvalue'
                        ? 'Sub-value'
                        : 'Existing value'}
                </button>
              ))}
            </div>
          )}

          {kind === 'existing-value' ? (
            <>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search values on this dimension…"
                className={inputCls}
              />
              <p className="text-xs leading-snug text-foreground/45">
                This MOVES the value here, with its sub-chain and every code answering it —
                it does not copy it. To have the same answer in two places, duplicate it
                first (⌘D). Its own descendants are not listed: re-parenting a value under
                its own child would close a cycle.
              </p>
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {valueHits.length === 0 && (
                  <p className="py-2 text-xs italic text-foreground/40">No value matches.</p>
                )}
                {valueHits.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    disabled={pending}
                    onClick={() => moveValueHere(v.id)}
                    className="w-full border border-transparent px-2 py-1.5 text-left text-xs transition hover:border-foreground/30 hover:bg-foreground/[0.03]"
                  >
                    {v.label}
                    {v.parent_id === null && (
                      <span className="ml-1 text-foreground/35">· currently a root</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          ) : kind === 'existing' ? (
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
                    <span className="font-mono">{h.mnemonic}</span>
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
              <Field
                label="Slug"
                hint={
                  normalizedSlug
                    ? slugTaken
                      ? `"${normalizedSlug}" is already in use — pick another.`
                      : `Saved as ${normalizedSlug}`
                    : 'The code’s sole identifier — you type it (e.g. reassign-driver).'
                }
              >
                <input
                  autoFocus
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className={`${inputCls} font-mono`}
                  placeholder="CONF-BIAS-REVIEW"
                />
              </Field>

              <Field label="Definition">
                <textarea
                  value={definition}
                  onChange={(e) => setDefinition(e.target.value)}
                  rows={3}
                  className={inputCls}
                />
              </Field>

              {/* The rest of the anatomy. These are versioned columns on
                  cb_code_versions — the same fields the full editor shows — so a code
                  authored here is not a second-class one that must be reopened later
                  to become usable. */}
              <BulletListEditor
                label="Include if"
                items={includeIf}
                onChange={setIncludeIf}
                placeholder="Add an inclusion clause…"
              />
              <BulletListEditor
                label="Exclude if"
                items={excludeIf}
                onChange={setExcludeIf}
                placeholder="Add an exclusion clause…"
              />
              <BulletListEditor
                label="Exemplars"
                items={exemplars}
                onChange={setExemplars}
                placeholder="Add an example…"
              />

              <Field
                label="Counter-example"
                hint="The near-miss that looks like this code but is NOT it. The single most useful field for inter-coder agreement."
              >
                <textarea
                  value={disconfirming}
                  onChange={(e) => setDisconfirming(e.target.value)}
                  rows={2}
                  className={inputCls}
                />
              </Field>

              <Field label="Origin">
                <div className="flex gap-1 text-xs">
                  {(['a_priori', 'pilot', 'emergent'] as const).map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => {
                        setOriginTouched(true);
                        setOriginChoice(o);
                      }}
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
                facets.map((f) => (
                  <Field
                    key={f.id}
                    label={f.label}
                    hint={
                      f.cardinality === 'multi'
                        ? 'more than one answer allowed — that is how a cross-cutting code is expressed'
                        : undefined
                    }
                  >
                    {/* A LIST, not a wrapped row of boxes: a picker whose geometry
                        reflows as values are added can never be learned. Nesting is
                        indent alone; picking a parent is a complete, coarser answer. */}
                    <ValueList
                      facet={f}
                      selectedIds={answers[f.id] ?? []}
                      onToggle={(valueId) =>
                        toggleAnswer(f.id, valueId, f.cardinality === 'multi')
                      }
                    />
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

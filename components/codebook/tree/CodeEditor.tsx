'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  addCodeFacetValue,
  duplicateCode,
  removeCodeFacetValue,
  renameCode,
  saveNewVersion,
  setCodeOrigin,
} from '@/app/actions/codes';
import { linkCitation, unlinkCitation } from '@/app/actions/citations';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import BulletListEditor from '@/components/code/BulletListEditor';
import type { ExemplarT } from '@/lib/types/contracts';
import type { Tables } from '@/lib/types/cb-db';
import ValueList from './ValueList';

type Citation = Tables<'cb_citations'>;

/**
 * The WHOLE code, editable in one place.
 *
 * There is no "full anatomy →" link any more. A link out of the inspector says the
 * inspector is a preview of the real thing somewhere else — which makes the inspector
 * pointless (why read a summary when the truth is one click away?) and the trip
 * expensive (you lose the canvas, and with it the reason you opened the code). If the
 * inspector's job is to let you understand and fix a code, it has to BE the editor.
 *
 * The same component backs the triage rows, so a code is edited identically wherever you
 * meet it. Three partial editors that drift apart is the failure this avoids.
 *
 * ANATOMY IS APPEND-ONLY. Editing any versioned field writes a NEW cb_code_versions row
 * rather than overwriting: the instrument's history has to survive a tightening you later
 * decide was wrong. So the version fields save TOGETHER, on an explicit "Save version"
 * — unlike name/mnemonic/answers, which are cheap and commit on blur. A per-keystroke
 * version history would be noise, and noise in a history is the same as no history.
 */
export default function CodeEditor({
  code,
  facets,
  citations,
  /** Convert this code into a VALUE of the shown dimension — for the case where it turns
   *  out to be the CATEGORY its sub-themes answer. */
  onPromote,
  promoteTo,
}: {
  code: CodeWithRefs;
  facets: FacetWithValues[];
  citations: Citation[];
  onPromote?: () => void;
  promoteTo?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [mnemonic, setMnemonic] = useState(code.mnemonic);
  const [name, setName] = useState(code.name);

  const v = code.current;
  const [definition, setDefinition] = useState(v?.definition ?? '');
  const [includeIf, setIncludeIf] = useState<string[]>(asStrings(v?.include_if));
  const [excludeIf, setExcludeIf] = useState<string[]>(asStrings(v?.exclude_if));
  const [exemplars, setExemplars] = useState<string[]>(asExemplarText(v?.exemplars));
  const [disconfirming, setDisconfirming] = useState(v?.disconfirming_pattern ?? '');
  const [prediction, setPrediction] = useState(v?.prediction ?? '');
  const [falsifier, setFalsifier] = useState(v?.prediction_falsifier ?? '');
  const [changeNote, setChangeNote] = useState('');

  const dirty =
    definition !== (v?.definition ?? '') ||
    !same(includeIf, asStrings(v?.include_if)) ||
    !same(excludeIf, asStrings(v?.exclude_if)) ||
    !same(exemplars, asExemplarText(v?.exemplars)) ||
    disconfirming !== (v?.disconfirming_pattern ?? '') ||
    prediction !== (v?.prediction ?? '') ||
    falsifier !== (v?.prediction_falsifier ?? '');

  function run(fn: () => Promise<unknown>, onFail?: () => void) {
    setError(null);
    start(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        onFail?.();
        setError(e instanceof Error ? e.message : 'Save failed.');
      }
    });
  }

  function saveVersion() {
    if (!definition.trim()) {
      setError('A code needs a definition.');
      return;
    }
    run(async () => {
      await saveNewVersion(code.id, {
        definition: definition.trim(),
        include_if: includeIf,
        exclude_if: excludeIf,
        exemplars: exemplars.map((text) => ({ text })),
        disconfirming_pattern: disconfirming.trim() || undefined,
        prediction: prediction.trim() || undefined,
        prediction_falsifier: falsifier.trim() || undefined,
        change_note: changeNote.trim() || undefined,
      });
      setChangeNote('');
    });
  }

  return (
    <div className="space-y-3">
      {/* Cheap fields: commit on blur. */}
      <div className="flex gap-2">
        <input
          value={mnemonic}
          disabled={pending}
          onChange={(e) => setMnemonic(e.target.value)}
          onBlur={() => {
            const next = mnemonic.trim();
            if (!next || next === code.mnemonic) {
              setMnemonic(code.mnemonic);
              return;
            }
            // A UNIQUE collision restores the old value and surfaces the error rather
            // than leaving the field showing text that was never saved.
            run(
              () => renameCode(code.id, { mnemonic: next }),
              () => setMnemonic(code.mnemonic),
            );
          }}
          aria-label="Mnemonic"
          className="w-32 shrink-0 border border-foreground/20 bg-background px-2 py-1 font-mono text-sm focus:border-foreground focus:outline-none"
        />
        <input
          value={name}
          disabled={pending}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (!next || next === code.name) {
              setName(code.name);
              return;
            }
            run(
              () => renameCode(code.id, { name: next }),
              () => setName(code.name),
            );
          }}
          aria-label="Name"
          className="min-w-0 flex-1 border border-foreground/20 bg-background px-2 py-1 text-sm focus:border-foreground focus:outline-none"
        />
      </div>

      <p className="text-xs text-foreground/45">
        {code.origin.replace('_', ' ')} · {code.status}
      </p>

      {/* ---- ANSWERS: what this code says on each dimension ---- */}
      {facets.map((f) => {
        const multi = f.cardinality === 'multi';
        const mine = f.values.filter((x) => code.facetValueIds.includes(x.id));
        return (
          <section key={f.id}>
            <p
              className={`mb-0.5 text-[11px] uppercase tracking-wide ${
                mine.length === 0 ? 'text-amber-700 dark:text-amber-500' : 'text-foreground/35'
              }`}
            >
              {f.label}
              {mine.length > 1 && (
                <span className="ml-1 normal-case tracking-normal">· cross-cuts</span>
              )}
            </p>
            <ValueList
              facet={f}
              selectedIds={mine.map((m) => m.id)}
              disabled={pending}
              onToggle={(valueId) =>
                run(async () => {
                  if (mine.some((m) => m.id === valueId)) {
                    await removeCodeFacetValue(code.id, valueId);
                    return;
                  }
                  // A `single` dimension admits ONE answer: a new pick replaces the old.
                  if (!multi) {
                    for (const m of mine) await removeCodeFacetValue(code.id, m.id);
                  }
                  await addCodeFacetValue(code.id, valueId);
                })
              }
            />
          </section>
        );
      })}

      {/* ---- ANATOMY: versioned, saved together ---- */}
      <section className="space-y-2 border-t border-foreground/10 pt-3">
        <Field label="Definition">
          <textarea
            value={definition}
            disabled={pending}
            onChange={(e) => setDefinition(e.target.value)}
            rows={3}
            className={input}
          />
        </Field>

        <BulletListEditor
          label="Include if"
          items={includeIf}
          onChange={setIncludeIf}
          disabled={pending}
          placeholder="Add an inclusion clause…"
        />
        <BulletListEditor
          label="Exclude if"
          items={excludeIf}
          onChange={setExcludeIf}
          disabled={pending}
          placeholder="Add an exclusion clause…"
        />
        <BulletListEditor
          label="Exemplars"
          items={exemplars}
          onChange={setExemplars}
          disabled={pending}
          placeholder="Add an example…"
        />

        <Field
          label="Counter-example"
          hint="The near-miss that looks like this code but is NOT it — the single most useful field for coder agreement."
        >
          <textarea
            value={disconfirming}
            disabled={pending}
            onChange={(e) => setDisconfirming(e.target.value)}
            rows={2}
            className={input}
          />
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Prediction">
            <textarea
              value={prediction}
              disabled={pending}
              onChange={(e) => setPrediction(e.target.value)}
              rows={2}
              className={input}
            />
          </Field>
          <Field label="…falsified by">
            <textarea
              value={falsifier}
              disabled={pending}
              onChange={(e) => setFalsifier(e.target.value)}
              rows={2}
              className={input}
            />
          </Field>
        </div>

        {/* The anatomy saves as ONE new version, deliberately: a version per keystroke is
            noise, and noise in a history is the same as no history. */}
        {dirty && (
          <div className="flex items-end gap-2">
            <Field label="What changed?">
              <input
                value={changeNote}
                disabled={pending}
                onChange={(e) => setChangeNote(e.target.value)}
                placeholder="e.g. tightened to exclude restatement"
                className={input}
              />
            </Field>
            <button
              type="button"
              onClick={saveVersion}
              disabled={pending}
              className="shrink-0 border border-foreground bg-foreground px-3 py-1.5 text-xs text-background transition hover:opacity-90 disabled:opacity-40"
            >
              {pending ? 'Saving…' : `Save v${(v?.version ?? 0) + 1}`}
            </button>
          </div>
        )}
      </section>

      {/* ---- PAPER ---- */}
      <section className="border-t border-foreground/10 pt-3">
        <p className="mb-0.5 text-[11px] uppercase tracking-wide text-foreground/35">Paper</p>
        <select
          value={code.citationIds[0] ?? ''}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value;
            run(async () => {
              for (const old of code.citationIds) await unlinkCitation(code.id, old);
              if (next) {
                await linkCitation(code.id, next, 'derived_from');
                await setCodeOrigin(code.id, 'a_priori');
              }
            });
          }}
          className={input}
        >
          <option value="">none</option>
          {citations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.bibtex_key ?? c.title ?? c.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </section>

      {/* ---- DUPLICATE ---- */}
      <section className="border-t border-foreground/10 pt-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => duplicateCode(code.id))}
          title="Copy the anatomy into a new code (⌘D). The copy drops the answers and lands in triage — you duplicate a code to make a variant, and the answers are what you will change."
          className="w-full border border-foreground/20 px-2 py-1.5 text-xs text-foreground/60 transition hover:border-foreground hover:text-foreground disabled:opacity-40"
        >
          Duplicate — anatomy only, lands in triage
        </button>
      </section>

      {/* ---- PROMOTE: this was never a code ---- */}
      {onPromote && (
        <section className="border-t border-foreground/10 pt-3">
          <button
            type="button"
            disabled={pending}
            onClick={onPromote}
            className="w-full border border-dashed border-foreground/30 px-2 py-1.5 text-xs text-foreground/60 transition hover:border-foreground hover:text-foreground disabled:opacity-40"
          >
            This is really a value of {promoteTo} →
          </button>
          <p className="mt-1 text-[11px] leading-snug text-foreground/40">
            A code is an OBSERVATION — you can point at a transcript line and say
            &ldquo;there&rdquo;. A value is an ANSWER. If you cannot point until you have
            decided WHICH sub-thing happened, it was never a code. Name and definition
            carry over; the code is retired, not deleted.
          </p>
        </section>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

const input =
  'w-full border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none disabled:opacity-50';

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
    <div className="min-w-0 flex-1 space-y-0.5">
      <label className="block text-[11px] uppercase tracking-wide text-foreground/35">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-foreground/40">{hint}</p>}
    </div>
  );
}

/** The versioned columns round-trip through Json, so they come back as `unknown`. */
function asStrings(j: unknown): string[] {
  return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
}

function asExemplarText(j: unknown): string[] {
  if (!Array.isArray(j)) return [];
  return j
    .map((raw) => (raw as Partial<ExemplarT>)?.text)
    .filter((t): t is string => typeof t === 'string');
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

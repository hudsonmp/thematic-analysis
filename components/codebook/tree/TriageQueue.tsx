'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  addCodeFacetValue,
  removeCodeFacetValue,
  renameCode,
  saveNewVersion,
  setCodeOrigin,
} from '@/app/actions/codes';
import { linkCitation, unlinkCitation } from '@/app/actions/citations';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { queueStats, triageQueue } from '@/lib/codebook/triage';
import type { Tables } from '@/lib/types/cb-db';
import ValueList from './ValueList';

type Citation = Tables<'cb_citations'>;

/**
 * The triage queue: classify — and EDIT — the codes you captured while reading.
 *
 * WHY IT EXISTS. Capture and classification are different cognitive modes. To classify
 * at capture time you must hold the whole scheme in working memory WHILE reading, so you
 * capture less and worse. Batching lets you load the scheme once and apply it N times.
 * The floating `+` therefore asks for nothing but the code; this is where the asking
 * happens.
 *
 * IT IS A LIST, NOT A CURSOR. It used to serve one code at a time behind ←/skip arrows.
 * That is a queue you cannot LOOK at: you could never see that four of your seven
 * captures were the same idea, because only one was ever on screen. Triage is not only
 * "answer the questions" — it is also "notice what you actually collected", and noticing
 * requires the set to be visible at once. Click a row to open it; edits commit on blur,
 * so clicking away loses nothing.
 *
 * Ordering is MOST-INCOMPLETE-FIRST with an alphabetical tiebreak, so the worst debt
 * surfaces first and the list cannot reshuffle under the cursor between renders.
 */
export default function TriageQueue({
  codes,
  facets,
  citations,
}: {
  codes: CodeWithRefs[];
  /** The answerable dimensions. A facet with no values is a question with no possible
   *  answer — parking codes behind it would be an unclearable debt. */
  facets: FacetWithValues[];
  /** The citation library — so a paper can be attached POST HOC. */
  citations: Citation[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  const queue = useMemo(() => triageQueue(codes, facets), [codes, facets]);
  const stats = useMemo(() => queueStats(codes, facets), [codes, facets]);

  if (queue.length === 0) {
    return (
      <p className="py-3 text-xs text-foreground/45">
        {stats.total === 0
          ? 'No codes yet. The corner + captures one without asking you to classify it.'
          : `All ${stats.total} codes are classified on every dimension.`}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-foreground/45">
        {queue.length} unclassified
        {stats.fullyUncategorized > 0 &&
          ` · ${stats.fullyUncategorized} with no answers at all`}
        {' · '}most incomplete first
      </p>

      <div className="space-y-1">
        {queue.map((item) => {
          const code = item.code;
          const open = openId === code.id;
          return (
            <div key={code.id} className="border border-foreground/15">
              {/* Draggable from the LIST as well as the staging box: the two are views of
                  the SAME unfiled pile, so a code must be draggable wherever it is shown
                  or the two views disagree about what you are allowed to do with it. */}
              <div
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/code-id', code.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => setOpenId(open ? null : code.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenId(open ? null : code.id);
                  }
                }}
                className={`flex cursor-grab items-baseline gap-2 px-2 py-1.5 text-left transition active:cursor-grabbing ${
                  open ? 'bg-foreground/[0.04]' : 'hover:bg-foreground/[0.03]'
                }`}
              >
                <span className="shrink-0 truncate font-mono text-xs text-foreground/50">
                  {code.mnemonic}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">{code.name}</span>
                <span
                  className="shrink-0 text-[11px] text-amber-700 dark:text-amber-500"
                  title={`${item.gaps.length} unanswered dimension${item.gaps.length === 1 ? '' : 's'}`}
                >
                  {item.gaps.length}
                </span>
              </div>

              {open && <TriageEditor code={code} facets={facets} citations={citations} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The open row. Everything about a captured code is editable HERE, because this is the
 * screen where you meet it again — the moment you can actually tell that the
 * auto-derived mnemonic reads badly, or that the definition you typed mid-reading is too
 * vague to code from.
 */
function TriageEditor({
  code,
  facets,
  citations,
}: {
  code: CodeWithRefs;
  facets: FacetWithValues[];
  citations: Citation[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [mnemonic, setMnemonic] = useState(code.mnemonic);
  const [name, setName] = useState(code.name);
  const [definition, setDefinition] = useState(code.current?.definition ?? '');

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

  return (
    <div className="space-y-2 border-t border-foreground/10 p-2">
      <div className="flex gap-1.5">
        <input
          value={mnemonic}
          disabled={pending}
          onChange={(e) => setMnemonic(e.target.value)}
          onBlur={() => {
            const next = mnemonic.trim();
            if (!next || next === code.mnemonic) {
              setMnemonic(code.mnemonic); // blank or unchanged is not an edit
              return;
            }
            // A UNIQUE collision restores the old value and surfaces the error rather
            // than leaving the field showing text that was never saved — a silent no-op
            // is the worst outcome for a field you deliberately changed.
            run(
              () => renameCode(code.id, { mnemonic: next }),
              () => setMnemonic(code.mnemonic),
            );
          }}
          aria-label="Mnemonic"
          className="w-28 shrink-0 border border-foreground/20 bg-background px-1.5 py-1 font-mono text-xs focus:border-foreground focus:outline-none"
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
          className="min-w-0 flex-1 border border-foreground/20 bg-background px-1.5 py-1 text-xs focus:border-foreground focus:outline-none"
        />
      </div>

      <textarea
        value={definition}
        disabled={pending}
        onChange={(e) => setDefinition(e.target.value)}
        onBlur={() => {
          const next = definition.trim();
          if (!next || next === (code.current?.definition ?? '')) return;
          // The codebook is APPEND-ONLY: editing a definition writes a NEW version rather
          // than overwriting, so the instrument's history survives a tightening you later
          // decide was wrong. The cost is a version per edit — acceptable while a code is
          // still in triage and nobody has coded against it.
          run(() =>
            saveNewVersion(code.id, {
              definition: next,
              include_if: [],
              exclude_if: [],
              exemplars: [],
              change_note: 'Tightened during triage',
            }),
          );
        }}
        rows={3}
        placeholder="Definition — what must be true of a segment for this to apply."
        className="w-full border border-foreground/20 bg-background px-1.5 py-1 text-xs leading-snug focus:border-foreground focus:outline-none"
      />

      {facets.map((f) => {
        const multi = f.cardinality === 'multi';
        const mine = f.values.filter((v) => code.facetValueIds.includes(v.id));
        return (
          <div key={f.id} className="border-t border-foreground/10 pt-1.5">
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
                  // A `single` dimension admits ONE answer: a new pick replaces the old,
                  // or the code would silently carry two answers on a dimension declared
                  // to allow one.
                  if (!multi) {
                    for (const m of mine) await removeCodeFacetValue(code.id, m.id);
                  }
                  await addCodeFacetValue(code.id, valueId);
                })
              }
            />
          </div>
        );
      })}

      {/* POST-HOC paper. You usually only realise which paper a code came from when you
          meet the code again — which is here. Attaching one flips origin to a_priori, for
          the same reason the up-front pin does. */}
      <div className="border-t border-foreground/10 pt-1.5">
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
          className="w-full border border-foreground/20 bg-background px-1.5 py-1 text-xs focus:border-foreground focus:outline-none disabled:opacity-50"
        >
          <option value="">none</option>
          {citations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.bibtex_key ?? c.title ?? c.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

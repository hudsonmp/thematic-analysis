'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { submitDrillReview, type DrillState } from '@/app/actions/drill';
import { splitDefinition } from '@/lib/codebook/definition';
import {
  newCard,
  parseCard,
  previewIntervals,
  type DrillRating,
  type FsrsCardJson,
} from '@/lib/drill/schedule';
import {
  buildQueue,
  deckStats,
  pickDistractors,
  exemplarFor,
  rankCodesForQuery,
  hashSeed,
  mulberry32,
  type DrillCode,
  type DrillMode,
  type QueueItem,
} from '@/lib/drill/cards';

/**
 * Drill home + sessions. Two practice DIRECTIONS, each with its own FSRS
 * schedule per code (recognition strength ≠ production strength):
 *
 *   QUIZ — recognition. Excerpt (or definition) on the front, 4 options,
 *   distractors are near-misses. Hovering an option shows its applied
 *   definition, so a discrimination can be made on meaning, not on slug
 *   familiarity.
 *
 *   NAME — production. Definition + exemplars on the front; the answer is
 *   picked from the FULL code list via a ranked filter field. Browsing the
 *   list is allowed: the retrieval act is recognizing the right slug among
 *   all of them, which is exactly the coding task.
 *
 * The OVERVIEW is the practice queue: per-direction due/new/scheduled counts,
 * a start button, and "practice ahead" (FSRS reviews early cards natively) —
 * plus the full per-code schedule table.
 *
 * Keys in session: quiz 1–4 pick · name ↑↓ + Enter · Enter/Space continue.
 */

const NEW_CAP = 10;
const OPTION_COUNT = 4;

function humanizeGap(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} d`;
  return `${Math.round(d / 30)} mo`;
}

function applied(def: string | null): string {
  return splitDefinition(def).applied;
}

type Result = { code: DrillCode; correct: boolean; pickedMnemonic: string | null };

// ---------------------------------------------------------------------------
// Home: mode select + practice queue
// ---------------------------------------------------------------------------

export default function DrillHome({
  codes,
  states,
}: {
  codes: DrillCode[];
  states: DrillState[];
}) {
  const [session, setSession] = useState<{ mode: DrillMode; queue: QueueItem[] } | null>(null);
  // Local mirror of scheduling states, updated as reviews come back, so
  // returning to the overview reflects the session without a server refetch.
  const [liveStates, setLiveStates] = useState<DrillState[]>(states);
  const [now] = useState(() => new Date());

  if (codes.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-sm text-foreground/60">
        No a priori codes to drill — the deck is built from codes with origin
        “a priori” across all codebooks.
      </main>
    );
  }

  if (session) {
    return (
      <Session
        mode={session.mode}
        queue={session.queue}
        codes={codes}
        onStateChange={(s) =>
          setLiveStates((prev) => [
            ...prev.filter((p) => !(p.codeId === s.codeId && p.cardType === s.cardType)),
            s,
          ])
        }
        onExit={() => setSession(null)}
      />
    );
  }

  const start = (mode: DrillMode, ahead: boolean) => {
    const at = new Date();
    const q = buildQueue(
      mode,
      codes,
      liveStates,
      at,
      NEW_CAP,
      hashSeed(`${mode}:${at.getTime()}`),
      ahead,
    );
    if (q.length > 0) setSession({ mode, queue: q });
  };

  const modes: { mode: DrillMode; title: string; blurb: string }[] = [
    {
      mode: 'quiz',
      title: 'Quiz — excerpt → code',
      blurb: 'A real coded excerpt, four near-miss options. Recognition.',
    },
    {
      mode: 'name',
      title: 'Cards — definition → code',
      blurb: 'Definition and exemplars shown; produce the code from the full list.',
    },
  ];

  // Per-code schedule rows, both directions, soonest first.
  const scheduleRows = liveStates
    .map((s) => ({
      state: s,
      code: codes.find((c) => c.id === s.codeId),
      dueAt: new Date(s.due).getTime(),
    }))
    .filter((r): r is typeof r & { code: DrillCode } => r.code !== undefined)
    .sort((a, b) => a.dueAt - b.dueAt);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-lg font-medium">Drill</h1>
      <p className="mt-1 text-sm text-foreground/60">
        Spaced practice on the {codes.length} a priori codes. FSRS schedules each card;
        answering is what counts, so cards you miss come back sooner.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {modes.map(({ mode, title, blurb }) => {
          const s = deckStats(mode, codes, liveStates, now);
          const startable = s.due + Math.min(s.fresh, NEW_CAP) > 0;
          return (
            <section key={mode} className="border border-foreground/15 p-4">
              <h2 className="text-sm font-medium">{title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-foreground/60">{blurb}</p>
              <p className="mt-3 text-xs text-foreground/60">
                <span className={s.due > 0 ? 'font-medium text-foreground' : ''}>
                  {s.due} due
                </span>{' '}
                · {s.fresh} new · {s.scheduled} scheduled
                {s.due === 0 && s.nextDueMs !== null && (
                  <> · next in {humanizeGap(s.nextDueMs - now.getTime())}</>
                )}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => start(mode, false)}
                  disabled={!startable}
                  className="border border-foreground/25 px-3 py-1.5 text-xs transition hover:bg-foreground/5 disabled:opacity-40"
                >
                  Start
                </button>
                {!startable && s.scheduled > 0 && (
                  <button
                    type="button"
                    onClick={() => start(mode, true)}
                    className="border border-foreground/15 px-3 py-1.5 text-xs text-foreground/60 transition hover:bg-foreground/5"
                  >
                    Practice ahead
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {scheduleRows.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-wide text-foreground/45">Queue</h2>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-foreground/45">
              <tr className="border-b border-foreground/15">
                <th className="py-1.5 pr-3 font-normal">code</th>
                <th className="py-1.5 pr-3 font-normal">direction</th>
                <th className="py-1.5 pr-3 font-normal">due</th>
                <th className="py-1.5 font-normal">reps · lapses</th>
              </tr>
            </thead>
            <tbody>
              {scheduleRows.map(({ state, code, dueAt }) => {
                const overdue = dueAt <= now.getTime();
                const f = state.fsrs as { reps?: number; lapses?: number } | null;
                return (
                  <tr
                    key={`${state.codeId}:${state.cardType}`}
                    className="border-b border-foreground/10"
                  >
                    <td className="py-1.5 pr-3 font-mono">{code.mnemonic}</td>
                    <td className="py-1.5 pr-3 text-foreground/60">
                      {state.cardType === 'name' ? 'cards' : 'quiz'}
                    </td>
                    <td className={`py-1.5 pr-3 ${overdue ? 'font-medium' : 'text-foreground/60'}`}>
                      {overdue ? 'now' : `in ${humanizeGap(dueAt - now.getTime())}`}
                    </td>
                    <td className="py-1.5 text-foreground/60">
                      {f?.reps ?? 0} · {f?.lapses ?? 0}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Session: shared frame for both directions
// ---------------------------------------------------------------------------

function Session({
  mode,
  queue,
  codes,
  onStateChange,
  onExit,
}: {
  mode: DrillMode;
  queue: QueueItem[];
  codes: DrillCode[];
  onStateChange: (s: DrillState) => void;
  onExit: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null); // code id; null = asking
  const [results, setResults] = useState<Result[]>([]);
  const [nextDueText, setNextDueText] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Non-null while a CORRECT pick awaits its Again/Hard/Good/Easy grade — the
  // projected interval for each button, computed at pick time from the card's
  // current FSRS state. Wrong picks never wait: they auto-grade Again.
  const [ratePreview, setRatePreview] = useState<Record<DrillRating, number> | null>(null);
  const [rated, setRated] = useState(false);
  const shownAtRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);

  const item = idx < queue.length ? queue[idx] : null;
  const revealed = picked !== null;
  const awaitingRating = revealed && ratePreview !== null && !rated;

  useEffect(() => {
    shownAtRef.current = performance.now();
  }, [idx]);

  const submit = (correct: boolean, rating: DrillRating | undefined, chosenId: string) => {
    if (!item) return;
    submitDrillReview({
      codeId: item.code.id,
      cardType: item.cardType,
      correct,
      rating,
      chosenCodeId: chosenId,
      elapsedMs: elapsedRef.current,
    })
      .then((s) => {
        onStateChange(s);
        setNextDueText(humanizeGap(new Date(s.due).getTime() - Date.now()));
      })
      .catch(() => setSaveError('review not saved — check connection'));
  };

  const pick = (code: DrillCode) => {
    if (!item || revealed) return;
    const correct = code.id === item.code.id;
    elapsedRef.current = Math.round(performance.now() - shownAtRef.current);
    setPicked(code.id);
    setResults((r) => [
      ...r,
      { code: item.code, correct, pickedMnemonic: correct ? null : code.mnemonic },
    ]);
    setNextDueText(null);
    setSaveError(null);
    if (correct) {
      // Hold for the self-grade; show what each grade would schedule.
      const at = new Date();
      const cur = item.fsrs !== null ? parseCard(item.fsrs as FsrsCardJson) : newCard(at);
      setRatePreview(previewIntervals(cur, at));
      setRated(false);
    } else {
      setRatePreview(null);
      setRated(true);
      submit(false, undefined, code.id);
    }
  };

  const advance = () => {
    setPicked(null);
    setNextDueText(null);
    setRatePreview(null);
    setRated(false);
    setIdx((i) => i + 1);
  };

  const rate = (r: DrillRating) => {
    if (!item || !awaitingRating) return;
    setRated(true);
    submit(true, r, item.code.id);
    advance(); // the rating IS the advance (Anki cadence)
  };

  // After a reveal: 1–4 grade a correct pick; Enter/Space advance a graded or
  // wrong one. (Quiz's option keys live in QuizCard, gated on !revealed; name
  // mode's field handles its own keys.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!revealed) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (awaitingRating) {
        const n = Number(e.key);
        if (n >= 1 && n <= 4) {
          e.preventDefault();
          rate(n as DrillRating);
        }
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        advance();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, awaitingRating]);

  if (!item) {
    const misses = results.filter((r) => !r.correct);
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-lg font-medium">Session done</h1>
        <p className="mt-2 text-sm text-foreground/60">
          {results.filter((r) => r.correct).length}/{results.length} correct
        </p>
        {misses.length > 0 && (
          <div className="mt-6">
            <h2 className="text-xs uppercase tracking-wide text-foreground/45">
              Missed — confusions to sit with
            </h2>
            <ul className="mt-2 space-y-2">
              {misses.map((m, i) => (
                <li key={i} className="border border-foreground/15 px-3 py-2 text-sm">
                  <span className="font-mono font-medium">{m.code.mnemonic}</span>
                  {m.pickedMnemonic && (
                    <span className="text-foreground/60"> — picked {m.pickedMnemonic}</span>
                  )}
                  {m.code.definition && (
                    <p className="mt-1 text-xs text-foreground/60">{applied(m.code.definition)}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <button
          type="button"
          onClick={onExit}
          className="mt-6 border border-foreground/25 px-3 py-1.5 text-xs transition hover:bg-foreground/5"
        >
          Back to queue
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="flex items-baseline justify-between text-xs text-foreground/45">
        <button
          type="button"
          onClick={onExit}
          className="underline underline-offset-2 transition hover:text-foreground"
        >
          ← queue
        </button>
        <span>
          card {idx + 1}/{queue.length}
          {results.length > 0 && (
            <> · {results.filter((r) => r.correct).length}/{results.length} correct</>
          )}
          {saveError && !revealed && <span className="ml-2 text-red-600">{saveError}</span>}
        </span>
        <span>
          {item.fsrs === null ? 'new' : 'review'} · {item.code.codebookName}
        </span>
      </header>

      {mode === 'quiz' ? (
        <QuizCard item={item} codes={codes} picked={picked} onPick={pick} />
      ) : (
        // key remounts the card per code — the filter field starts clean with
        // no reset-in-effect.
        <NameCard key={item.code.id} item={item} codes={codes} picked={picked} onPick={pick} />
      )}

      {revealed && (
        <section className="mt-6 border border-foreground/15 p-4 text-sm">
          <p className="font-mono font-medium">{item.code.mnemonic}</p>
          {item.code.definition && (
            <p className="mt-2 leading-relaxed text-foreground/80">
              {applied(item.code.definition)}
            </p>
          )}
          {item.code.counterExample && (
            <p className="mt-2 text-xs text-foreground/60">
              <span className="uppercase tracking-wide text-foreground/45">not this when · </span>
              {item.code.counterExample}
            </p>
          )}
          {awaitingRating && ratePreview ? (
            // Correct pick: grade it. Each button shows what it schedules;
            // the rating advances to the next card (Anki cadence). Again stays
            // available to disown a lucky guess.
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {(
                [
                  { r: 1 as const, label: 'Again' },
                  { r: 2 as const, label: 'Hard' },
                  { r: 3 as const, label: 'Good' },
                  { r: 4 as const, label: 'Easy' },
                ]
              ).map(({ r, label }) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => rate(r)}
                  className={`flex-1 border px-3 py-1.5 text-xs transition hover:bg-foreground/5 ${
                    r === 3 ? 'border-foreground/40' : 'border-foreground/20'
                  }`}
                >
                  <span className="mr-1 text-foreground/40">{r}</span>
                  {label}
                  <span className="ml-1.5 text-foreground/45">{humanizeGap(ratePreview[r])}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-foreground/45">
                {saveError ?? (nextDueText ? `next review in ~${nextDueText}` : 'saving…')}
              </span>
              <button
                type="button"
                onClick={advance}
                className="border border-foreground/25 px-3 py-1.5 text-xs transition hover:bg-foreground/5"
              >
                Continue ⏎
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Quiz direction: 4 options, hover shows the applied definition
// ---------------------------------------------------------------------------

function QuizCard({
  item,
  codes,
  picked,
  onPick,
}: {
  item: QueueItem;
  codes: DrillCode[];
  picked: string | null;
  onPick: (c: DrillCode) => void;
}) {
  const revealed = picked !== null;
  const isClassify = item.cardType === 'classify';

  const options = useMemo(() => {
    const seed = hashSeed(item.code.id) ^ item.reps;
    const pool = codes.filter((c) => c.codebookName === item.code.codebookName);
    const distractors = pickDistractors(item.code, pool, OPTION_COUNT - 1, seed);
    const rand = mulberry32(seed ^ 0x9e3779b9);
    const all = [item.code, ...distractors];
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all;
  }, [item, codes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (revealed) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= options.length) {
        e.preventDefault();
        onPick(options[n - 1]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, options]);

  const front = isClassify ? exemplarFor(item.code, item.reps) : applied(item.code.definition);
  const extraExemplar =
    isClassify && item.code.exemplars.length > 1
      ? item.code.exemplars[(item.reps + 1) % item.code.exemplars.length]
      : null;

  return (
    <>
      <section className="mt-6">
        <p className="text-xs uppercase tracking-wide text-foreground/45">
          {isClassify ? 'Which code applies to this excerpt?' : 'Which code has this definition?'}
        </p>
        <blockquote
          className={`mt-3 border-l-2 border-foreground/25 pl-4 text-[15px] leading-relaxed ${
            isClassify ? 'italic' : ''
          }`}
        >
          {front || <span className="text-foreground/45">(no text on this card)</span>}
        </blockquote>
      </section>

      <ul className="mt-6 space-y-2">
        {options.map((opt, i) => {
          const isTarget = opt.id === item.code.id;
          const isPicked = picked === opt.id;
          let cls = 'border-foreground/15 hover:bg-foreground/5';
          if (revealed) {
            if (isTarget) cls = 'border-emerald-600/60 bg-emerald-500/10';
            else if (isPicked) cls = 'border-red-600/60 bg-red-500/10';
            else cls = 'border-foreground/10 opacity-50';
          }
          const def = applied(opt.definition);
          return (
            <li key={opt.id} className="group relative">
              <button
                type="button"
                onClick={() => onPick(opt)}
                disabled={revealed}
                className={`w-full border px-3 py-2 text-left text-sm transition ${cls}`}
              >
                <span className="mr-2 text-xs text-foreground/45">{i + 1}</span>
                <span className="font-mono">{opt.mnemonic}</span>
              </button>
              {(def || opt.exemplars.length > 0) && (
                <div className="pointer-events-none absolute left-2 right-2 top-full z-20 mt-1 hidden border border-foreground/20 bg-background p-3 text-xs leading-relaxed text-foreground/80 shadow-lg group-hover:block">
                  {def && <p>{def}</p>}
                  {opt.exemplars.slice(0, 2).map((ex, j) => (
                    <p key={j} className="mt-1.5 italic text-foreground/55">
                      “{ex.length > 180 ? `${ex.slice(0, 180)}…` : ex}”
                    </p>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {revealed && extraExemplar && (
        <p className="mt-4 text-xs italic text-foreground/60">“{extraExemplar}”</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Name direction: definition + exemplars front, answer from the full list
// ---------------------------------------------------------------------------

function NameCard({
  item,
  codes,
  picked,
  onPick,
}: {
  item: QueueItem;
  codes: DrillCode[];
  picked: string | null;
  onPick: (c: DrillCode) => void;
}) {
  const revealed = picked !== null;
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // The answer space is the same codebook's full code list — cross-instrument
  // slugs would be noise, not choices.
  const pool = useMemo(
    () => codes.filter((c) => c.codebookName === item.code.codebookName),
    [codes, item],
  );
  const hits = useMemo(() => rankCodesForQuery(pool, query), [pool, query]);
  const clampedCursor = Math.min(cursor, Math.max(0, hits.length - 1));

  // Keep the cursor row in view while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-cursor="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [clampedCursor, query]);

  const exemplar = exemplarFor(item.code, item.reps);

  return (
    <>
      <section className="mt-6">
        <p className="text-xs uppercase tracking-wide text-foreground/45">Name this code</p>
        {item.code.definition && (
          <p className="mt-3 text-[15px] leading-relaxed">{applied(item.code.definition)}</p>
        )}
        {exemplar && (
          <blockquote className="mt-3 border-l-2 border-foreground/25 pl-4 text-sm italic leading-relaxed text-foreground/80">
            {exemplar}
          </blockquote>
        )}
      </section>

      <div className="mt-6">
        <input
          ref={inputRef}
          type="text"
          value={query}
          autoFocus
          disabled={revealed}
          placeholder="type to filter, ↑↓ to move, ⏎ to answer"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (revealed) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, hits.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter' && hits[clampedCursor]) {
              e.preventDefault();
              onPick(hits[clampedCursor]);
            }
          }}
          className="w-full border border-foreground/25 bg-transparent px-3 py-2 font-mono text-sm outline-none placeholder:font-sans placeholder:text-foreground/40 focus:border-foreground/50"
        />
        <ul ref={listRef} className="mt-2 max-h-64 overflow-y-auto border border-foreground/15">
          {hits.map((c, i) => {
            const isTarget = c.id === item.code.id;
            const isPicked = picked === c.id;
            let cls = i === clampedCursor && !revealed ? 'bg-foreground/5' : '';
            if (revealed) {
              if (isTarget) cls = 'bg-emerald-500/10 text-foreground';
              else if (isPicked) cls = 'bg-red-500/10';
              else cls = 'opacity-50';
            }
            return (
              <li key={c.id} data-cursor={i === clampedCursor && !revealed}>
                <button
                  type="button"
                  disabled={revealed}
                  onClick={() => onPick(c)}
                  onMouseEnter={() => !revealed && setCursor(i)}
                  className={`w-full px-3 py-1.5 text-left font-mono text-sm transition ${cls}`}
                >
                  {c.mnemonic}
                </button>
              </li>
            );
          })}
          {hits.length === 0 && (
            <li className="px-3 py-2 text-xs text-foreground/45">no code matches “{query}”</li>
          )}
        </ul>
      </div>
    </>
  );
}

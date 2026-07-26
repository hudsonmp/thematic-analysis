'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { submitDrillReview, type DrillState } from '@/app/actions/drill';
import {
  buildQueue,
  pickDistractors,
  exemplarFor,
  hashSeed,
  mulberry32,
  type DrillCode,
  type QueueItem,
} from '@/lib/drill/cards';

/**
 * One drill session: every due card plus up to NEW_CAP unseen codes,
 * interleaved. Each card is a 4-option discrimination — the excerpt (or
 * definition) on top, the target code hidden among near-miss distractors
 * drawn from the same codebook. The pick auto-grades the FSRS review
 * (right → Good, wrong → Again); feedback always restates the definition and
 * the counter-example, because the moment after an error is where the
 * discrimination actually gets learned.
 *
 * Keys: 1–4 pick an option, Enter / Space advance after the reveal.
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

type Result = { code: DrillCode; correct: boolean; pickedMnemonic: string | null };

export default function DrillSession({
  codes,
  states,
}: {
  codes: DrillCode[];
  states: DrillState[];
}) {
  // The queue is fixed at mount: a drill session is a closed set, not a live
  // view — cards answered wrongly are NOT re-queued this session (FSRS's
  // 10-minute relearning step will surface them next visit; immediate
  // re-presentation only rehearses the answer while it's still in working
  // memory).
  const [sessionStart] = useState(() => Date.now());
  const [queue] = useState<QueueItem[]>(() =>
    buildQueue(codes, states, new Date(), NEW_CAP, hashSeed(new Date().toDateString())),
  );
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null); // code id, null = still asking
  const [results, setResults] = useState<Result[]>([]);
  const [nextDueText, setNextDueText] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const shownAtRef = useRef<number>(0);

  const item = idx < queue.length ? queue[idx] : null;
  const revealed = picked !== null;

  // Options are derived, seeded by the code id — stable across re-renders,
  // different across codes. Distractors come from the SAME codebook only.
  const options = useMemo(() => {
    if (!item) return [];
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

  // Stamp when the current card was first shown (ref write only).
  useEffect(() => {
    shownAtRef.current = performance.now();
  }, [idx]);

  const pick = (code: DrillCode) => {
    if (!item || revealed) return;
    const correct = code.id === item.code.id;
    const elapsed = Math.round(performance.now() - shownAtRef.current);
    setPicked(code.id);
    setResults((r) => [
      ...r,
      { code: item.code, correct, pickedMnemonic: correct ? null : code.mnemonic },
    ]);
    setNextDueText(null);
    setSaveError(null);
    submitDrillReview({
      codeId: item.code.id,
      cardType: item.cardType,
      correct,
      chosenCodeId: code.id,
      elapsedMs: elapsed,
    })
      .then((s) => setNextDueText(humanizeGap(new Date(s.due).getTime() - Date.now())))
      .catch(() => setSaveError('review not saved — check connection'));
  };

  const advance = () => {
    if (!revealed) return;
    setPicked(null);
    setNextDueText(null);
    setIdx((i) => i + 1);
  };

  // 1–4 pick, Enter/Space advance. Not bound while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (picked === null) {
        const n = Number(e.key);
        if (n >= 1 && n <= options.length) {
          e.preventDefault();
          pick(options[n - 1]);
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        advance();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, options, idx]);

  if (codes.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-sm text-foreground/60">
        No a priori codes to drill — the deck is built from codes with origin
        “a priori” across all codebooks.
      </main>
    );
  }

  // ---- summary / all-caught-up ----
  if (!item) {
    const nDue = queue.filter((q) => q.fsrs !== null).length;
    const misses = results.filter((r) => !r.correct);
    const nextDueAt = states
      .map((s) => new Date(s.due).getTime())
      .filter((t) => t > sessionStart)
      .sort((a, b) => a - b)[0];
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        {queue.length === 0 ? (
          <>
            <h1 className="text-lg font-medium">Nothing due</h1>
            <p className="mt-2 text-sm text-foreground/60">
              All {states.length} drilled codes are scheduled ahead.
              {nextDueAt && <> Next card due in {humanizeGap(nextDueAt - sessionStart)}.</>}
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-medium">Session done</h1>
            <p className="mt-2 text-sm text-foreground/60">
              {results.filter((r) => r.correct).length}/{results.length} correct ·{' '}
              {nDue} review{nDue === 1 ? '' : 's'} · {queue.length - nDue} new
            </p>
            {misses.length > 0 && (
              <div className="mt-6">
                <h2 className="text-xs uppercase tracking-wide text-foreground/45">
                  Missed — confusions to sit with
                </h2>
                <ul className="mt-2 space-y-2">
                  {misses.map((m, i) => (
                    <li key={i} className="border border-foreground/15 px-3 py-2 text-sm">
                      <span className="font-medium">{m.code.mnemonic}</span>
                      {m.pickedMnemonic && (
                        <span className="text-foreground/60"> — picked {m.pickedMnemonic}</span>
                      )}
                      {m.code.definition && (
                        <p className="mt-1 text-xs text-foreground/60">{m.code.definition}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-6 text-xs text-foreground/45">
              Missed cards come back on the FSRS relearning step — drill again in ~10
              minutes or tomorrow.
            </p>
          </>
        )}
      </main>
    );
  }

  // ---- one card ----
  const isClassify = item.cardType === 'classify';
  const front = isClassify ? exemplarFor(item.code, item.reps) : (item.code.definition ?? '');
  const extraExemplar =
    isClassify && item.code.exemplars.length > 1
      ? item.code.exemplars[(item.reps + 1) % item.code.exemplars.length]
      : null;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="flex items-baseline justify-between text-xs text-foreground/45">
        <span>
          card {idx + 1}/{queue.length}
          {results.length > 0 && (
            <> · {results.filter((r) => r.correct).length}/{results.length} correct</>
          )}
        </span>
        <span>{item.fsrs === null ? 'new' : 'review'} · {item.code.codebookName}</span>
      </header>

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
          return (
            <li key={opt.id}>
              <button
                type="button"
                onClick={() => pick(opt)}
                disabled={revealed}
                className={`w-full border px-3 py-2 text-left text-sm transition ${cls}`}
              >
                <span className="mr-2 text-xs text-foreground/45">{i + 1}</span>
                <span className="font-mono">{opt.mnemonic}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {revealed && (
        <section className="mt-6 border border-foreground/15 p-4 text-sm">
          <p className="font-mono font-medium">{item.code.mnemonic}</p>
          {item.code.definition && (
            <p className="mt-2 leading-relaxed text-foreground/80">{item.code.definition}</p>
          )}
          {item.code.counterExample && (
            <p className="mt-2 text-xs text-foreground/60">
              <span className="uppercase tracking-wide text-foreground/45">not this when · </span>
              {item.code.counterExample}
            </p>
          )}
          {extraExemplar && (
            <p className="mt-2 text-xs italic text-foreground/60">“{extraExemplar}”</p>
          )}
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
        </section>
      )}
    </main>
  );
}

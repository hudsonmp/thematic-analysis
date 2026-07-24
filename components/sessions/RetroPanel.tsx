'use client';

import { useMemo, useRef, useState } from 'react';
import type { RetroMemo, RetroQuestion } from '@/app/actions/retro-memos';
import type { RetroQuestionMark } from '@/lib/live/retro';

type BankMain = RetroQuestion & { subs: RetroQuestion[] };

/** Canonical retrospective episode names → bank source_key (the sync stamps
 *  these when importing the study's authored questions). */
const EPISODE_TO_KEY: [RegExp, string][] = [
  [/^scenario retrospective$/i, 'scenario_retro'],
  [/^general retrospective question i$/i, 'general_retro_1'],
  [/^general retrospective question ii$/i, 'general_retro_2'],
  [/^general retrospective question iii$/i, 'general_retro_3'],
];

/**
 * The RETROSPECTIVE panel — the right side of retro mode. Two regions:
 * a compact QUESTION LIST (the study's real questions, synced from
 * authored_data, plus hand-added mains/subquestions) on top, and a DOCUMENT
 * EDITOR for the selected question filling the rest — the memo is analytic
 * writing, not a form field, so it gets writing space: full-height textarea,
 * comfortable type, autosave on blur, ⌘⏎ to save explicitly.
 *
 * Plain text on purpose — retrospective answers are context-dependent on how
 * this participant solved the task, so the memo captures situated meaning
 * first; themes come later, ACROSS participants, which is why memos hang off
 * canonical bank ids rather than the per-pid asked-question observations.
 *
 * All data arrives via props; every fetch/mutation goes through parent
 * handlers (fetching stays in event handlers — repo: no setState-in-effect).
 */
export default function RetroPanel({
  myUid,
  currentEpisodeName,
  askedQuestions,
  playheadLabel,
  isPaused,
  onTogglePlay,
  bank,
  memos,
  busy,
  error,
  onSync,
  onCreateQuestion,
  onDeleteQuestion,
  onSaveMemo,
}: {
  myUid: string | null;
  currentEpisodeName: string | null;
  /** Live-queued questions already asked by the playhead (context, newest last). */
  askedQuestions: RetroQuestionMark[];
  playheadLabel: string;
  isPaused: boolean;
  onTogglePlay: () => void;
  bank: BankMain[] | null;
  memos: RetroMemo[] | null;
  busy: boolean;
  error: string | null;
  /** Import the study's authored retrospective questions (idempotent). */
  onSync: () => void;
  onCreateQuestion: (text: string, parentId: string | null) => void;
  onDeleteQuestion: (id: string) => void;
  onSaveMemo: (questionId: string, body: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addingUnder, setAddingUnder] = useState<string | null>(null); // main id, or '' for a new main
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const memoRef = useRef<HTMLTextAreaElement | null>(null);
  const addRef = useRef<HTMLInputElement | null>(null);

  // Auto-orientation: with no manual selection, follow the CURRENT
  // retrospective episode — source_key first (survives question-text edits),
  // exact text second (hand-added questions named after the episode).
  const effectiveSelectedId = useMemo(() => {
    if (selectedId !== null) return selectedId;
    if (bank === null || currentEpisodeName === null) return null;
    const name = currentEpisodeName.trim();
    const key = EPISODE_TO_KEY.find(([re]) => re.test(name))?.[1] ?? null;
    if (key !== null) {
      const byKey = bank.find((m) => m.source_key === key);
      if (byKey) return byKey.id;
    }
    return bank.find((m) => m.text.trim().toLowerCase() === name.toLowerCase())?.id ?? null;
  }, [selectedId, bank, currentEpisodeName]);

  const allQuestions: RetroQuestion[] = useMemo(
    () => (bank ?? []).flatMap((m) => [m, ...m.subs]),
    [bank],
  );
  const selectedQuestion = allQuestions.find((q) => q.id === effectiveSelectedId) ?? null;

  const myMemoFor = (questionId: string): RetroMemo | null =>
    memos?.find((m) => m.question_id === questionId && m.author_id === myUid) ?? null;
  const otherMemosFor = (questionId: string): RetroMemo[] =>
    memos?.filter(
      (m) => m.question_id === questionId && m.author_id !== myUid && m.body.trim() !== '',
    ) ?? [];

  const saveSelected = async (silent = false) => {
    if (!selectedQuestion) return;
    const body = memoRef.current?.value ?? '';
    const existing = myMemoFor(selectedQuestion.id)?.body ?? '';
    if (silent && body === existing) return; // blur with no change = no write
    await onSaveMemo(selectedQuestion.id, body);
    setSavedFor(selectedQuestion.id);
  };

  const submitAdd = () => {
    const text = addRef.current?.value.trim() ?? '';
    if (text === '') return;
    onCreateQuestion(text, addingUnder === '' ? null : addingUnder);
    if (addRef.current) addRef.current.value = '';
    setAddingUnder(null);
  };

  const Row = ({ q, isSub }: { q: RetroQuestion; isSub: boolean }) => {
    const selected = q.id === effectiveSelectedId;
    const hasMemo = (myMemoFor(q.id)?.body.trim() ?? '') !== '';
    return (
      <div className={`group flex items-center gap-1 ${isSub ? 'ml-4' : ''}`}>
        <button
          type="button"
          onClick={() => {
            setSavedFor(null);
            setSelectedId(q.id);
          }}
          className={`min-w-0 flex-1 truncate border-l-2 px-2 py-1 text-left text-xs transition ${
            selected
              ? 'border-sky-500 bg-sky-500/5 font-medium'
              : hasMemo
                ? 'border-emerald-500/60 hover:bg-foreground/[0.03]'
                : 'border-foreground/15 hover:bg-foreground/[0.03]'
          }`}
          title={q.text}
        >
          {hasMemo && <span className="mr-1 text-emerald-700/80 dark:text-emerald-400/80">●</span>}
          {q.text}
        </button>
        <button
          type="button"
          onClick={() => {
            if (
              confirm(`Delete "${q.text}"? Subquestions and every coder's memos on it go too.`)
            ) {
              onDeleteQuestion(q.id);
            }
          }}
          className="shrink-0 px-1 text-xs text-foreground/0 transition group-hover:text-foreground/30 hover:!text-red-600"
          aria-label={`Delete ${q.text}`}
        >
          ×
        </button>
      </div>
    );
  };

  return (
    <aside className="flex h-[85vh] flex-col rounded border border-foreground/15">
      {/* Header: orientation + transport. */}
      <div className="border-b border-foreground/15 px-3 py-2">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-foreground/40">
            Retrospective · {playheadLabel} · ←/→ ±5s
          </p>
          <button
            type="button"
            onClick={onTogglePlay}
            className="shrink-0 border border-foreground/25 px-2 py-0.5 text-xs transition hover:border-foreground"
          >
            {isPaused ? '▶ Play' : '⏸ Pause'}
          </button>
        </div>
        <h2 className="mt-0.5 truncate text-sm font-semibold">
          {currentEpisodeName ?? 'Not in a retrospective section'}
        </h2>
        {askedQuestions.length > 0 && (
          <p className="mt-0.5 truncate text-xs italic text-foreground/50" title={askedQuestions[askedQuestions.length - 1].body}>
            last asked: &ldquo;{askedQuestions[askedQuestions.length - 1].body}&rdquo;
          </p>
        )}
      </div>

      {/* Question list — compact, capped, the editor below gets the space. */}
      <div className="max-h-[38%] overflow-y-auto border-b border-foreground/15 px-3 py-2">
        {bank === null ? (
          <p className="text-xs italic text-foreground/40">Loading questions…</p>
        ) : bank.length === 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-foreground/50">
              No questions yet — load the ones each participant actually saw (from the
              study&rsquo;s authored task), then add subquestions under them.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={onSync}
              className="border border-foreground px-2 py-1 text-xs transition hover:bg-foreground hover:text-background disabled:opacity-40"
            >
              Load questions from study
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            {bank.map((m) => (
              <div key={m.id}>
                <Row q={m} isSub={false} />
                {m.subs.map((sub) => (
                  <Row key={sub.id} q={sub} isSub />
                ))}
                {addingUnder === m.id ? (
                  <div className="ml-4 mt-1 flex items-center gap-1.5">
                    <input
                      ref={addRef}
                      autoFocus
                      placeholder="Subquestion…"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          submitAdd();
                        }
                        if (e.key === 'Escape') setAddingUnder(null);
                      }}
                      className="min-w-0 flex-1 border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={submitAdd}
                      className="shrink-0 border border-foreground px-2 py-1 text-xs hover:bg-foreground hover:text-background disabled:opacity-40"
                    >
                      Add
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingUnder(m.id)}
                    className="ml-4 text-[10px] text-foreground/35 underline-offset-2 hover:text-foreground hover:underline"
                  >
                    + subquestion
                  </button>
                )}
              </div>
            ))}
            <div className="flex items-center gap-3 pt-1">
              {addingUnder === '' ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <input
                    ref={addRef}
                    autoFocus
                    placeholder="New main question…"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        submitAdd();
                      }
                      if (e.key === 'Escape') setAddingUnder(null);
                    }}
                    className="min-w-0 flex-1 border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={submitAdd}
                    className="shrink-0 border border-foreground px-2 py-1 text-xs hover:bg-foreground hover:text-background disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingUnder('')}
                  className="text-[10px] text-foreground/40 underline-offset-2 hover:text-foreground hover:underline"
                >
                  + main question
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={onSync}
                title="Re-import the study's authored questions (adds only what's missing)"
                className="ml-auto shrink-0 text-[10px] text-foreground/40 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
              >
                ⟳ sync from study
              </button>
            </div>
          </div>
        )}
      </div>

      {/* THE MEMO DOCUMENT — the panel's real workspace. */}
      {selectedQuestion ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
          <p className="mb-1.5 text-sm font-medium leading-snug">{selectedQuestion.text}</p>
          {otherMemosFor(selectedQuestion.id).length > 0 && (
            <details className="mb-1.5">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-foreground/40">
                Co-coder memos ({otherMemosFor(selectedQuestion.id).length})
              </summary>
              {otherMemosFor(selectedQuestion.id).map((m) => (
                <p
                  key={m.id}
                  className="mt-1 whitespace-pre-wrap border-l-2 border-foreground/15 pl-2 text-xs italic text-foreground/60"
                >
                  {m.body}
                </p>
              ))}
            </details>
          )}
          <textarea
            key={`${selectedQuestion.id}:${myMemoFor(selectedQuestion.id)?.updated_at ?? 'new'}`}
            ref={memoRef}
            defaultValue={myMemoFor(selectedQuestion.id)?.body ?? ''}
            placeholder={
              'Memo — what did THIS participant’s answer mean, given how they solved it?\n\nWrite freely; it autosaves when you click away. Themes come later, across participants.'
            }
            onBlur={() => void saveSelected(true)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void saveSelected();
              }
            }}
            className="min-h-0 w-full flex-1 resize-none border border-foreground/10 bg-background px-3 py-2.5 text-[15px] leading-relaxed focus:border-foreground/30 focus:outline-none"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveSelected()}
              className="border border-foreground px-2 py-0.5 text-xs transition hover:bg-foreground hover:text-background disabled:opacity-40"
            >
              Save memo
            </button>
            <span className="text-[10px] text-foreground/40">⌘⏎ · autosaves on blur</span>
            {savedFor === selectedQuestion.id && (
              <span className="text-[10px] text-emerald-700 dark:text-emerald-400">saved ✓</span>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="text-center text-xs italic text-foreground/40">
            Pick a question above — or scrub into a retrospective section and it selects
            itself.
          </p>
        </div>
      )}

      {error && <p className="px-3 pb-2 text-xs text-red-600">{error}</p>}
    </aside>
  );
}

'use client';

import { useMemo, useRef, useState } from 'react';
import type { RetroMemo, RetroQuestion } from '@/app/actions/retro-memos';
import type { RetroQuestionMark } from '@/lib/live/retro';

type BankMain = RetroQuestion & { subs: RetroQuestion[] };

/**
 * The RETROSPECTIVE panel — the right side of retro mode. The transcript keeps
 * the left; video/events/flags are hidden (audio keeps playing — transport is
 * space / ← →). One job: while listening to a participant answer a
 * retrospective question, write the situated MEMO for that question.
 *
 * Structure: the codebook's question BANK (mains + one level of subquestions,
 * editable inline) with ONE plain-text memo per (question, participant, coder).
 * Plain text on purpose — retrospective answers are context-dependent on how
 * this participant solved the task, so the memo captures situated meaning
 * first; themes come later, ACROSS participants, which is why memos hang off
 * canonical bank ids rather than the per-pid asked-question observations. The
 * asked questions (live queue) render as context above the bank.
 *
 * All data arrives via props and every fetch/mutation goes through parent
 * handlers — fetching stays in event handlers (repo: no setState-in-effect).
 */
export default function RetroPanel({
  myUid,
  currentEpisodeName,
  askedQuestions,
  playheadLabel,
  bank,
  memos,
  busy,
  error,
  onSeed,
  onCreateQuestion,
  onDeleteQuestion,
  onSaveMemo,
}: {
  myUid: string | null;
  /** The episode now playing (auto-derived) — the panel's orientation header. */
  currentEpisodeName: string | null;
  /** Live-queued questions already asked by the playhead (context, newest last). */
  askedQuestions: RetroQuestionMark[];
  playheadLabel: string;
  bank: BankMain[] | null;
  memos: RetroMemo[] | null;
  busy: boolean;
  error: string | null;
  onSeed: () => void;
  onCreateQuestion: (text: string, parentId: string | null) => void;
  onDeleteQuestion: (id: string) => void;
  onSaveMemo: (questionId: string, body: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addingUnder, setAddingUnder] = useState<string | null>(null); // main id or '' for a new main
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const memoRef = useRef<HTMLTextAreaElement | null>(null);
  const addRef = useRef<HTMLInputElement | null>(null);

  // Auto-orientation: with no manual selection, the selected question follows
  // the CURRENT retrospective episode by name match — scrub into "General
  // Retrospective Question II" and its memo editor is already open.
  const effectiveSelectedId = useMemo(() => {
    if (selectedId !== null) return selectedId;
    if (bank === null || currentEpisodeName === null) return null;
    const hit = bank.find(
      (m) => m.text.trim().toLowerCase() === currentEpisodeName.trim().toLowerCase(),
    );
    return hit?.id ?? null;
  }, [selectedId, bank, currentEpisodeName]);

  const myMemoFor = (questionId: string): RetroMemo | null =>
    memos?.find((m) => m.question_id === questionId && m.author_id === myUid) ?? null;
  const otherMemosFor = (questionId: string): RetroMemo[] =>
    memos?.filter((m) => m.question_id === questionId && m.author_id !== myUid && m.body.trim() !== '') ?? [];

  const saveSelected = async () => {
    if (!effectiveSelectedId) return;
    await onSaveMemo(effectiveSelectedId, memoRef.current?.value ?? '');
    setSavedFor(effectiveSelectedId);
  };

  const submitAdd = () => {
    const text = addRef.current?.value.trim() ?? '';
    if (text === '') return;
    onCreateQuestion(text, addingUnder === '' ? null : addingUnder);
    if (addRef.current) addRef.current.value = '';
    setAddingUnder(null);
  };

  const QuestionRow = ({ q, isSub }: { q: RetroQuestion; isSub: boolean }) => {
    const selected = q.id === effectiveSelectedId;
    const memo = myMemoFor(q.id);
    const others = otherMemosFor(q.id);
    return (
      <div className={isSub ? 'ml-4' : ''}>
        <div className="group flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSavedFor(null);
              setSelectedId(q.id === selectedId ? null : q.id);
            }}
            className={`min-w-0 flex-1 border-l-2 px-2 py-1 text-left text-sm transition ${
              selected
                ? 'border-sky-500 bg-sky-500/5 font-medium'
                : memo && memo.body.trim() !== ''
                  ? 'border-emerald-500/60 hover:bg-foreground/[0.03]'
                  : 'border-foreground/15 hover:bg-foreground/[0.03]'
            }`}
          >
            {q.text}
            {memo && memo.body.trim() !== '' && !selected && (
              <span className="ml-1.5 text-[10px] text-emerald-700/70 dark:text-emerald-400/70">
                memo ✓
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm(`Delete "${q.text}"? Subquestions and every coder's memos on it go too.`)) {
                onDeleteQuestion(q.id);
              }
            }}
            className="shrink-0 px-1 text-xs text-foreground/0 transition group-hover:text-foreground/30 hover:!text-red-600"
            aria-label={`Delete ${q.text}`}
          >
            ×
          </button>
        </div>
        {selected && (
          <div className="mb-2 ml-2 mt-1 space-y-1.5 border-l-2 border-sky-500/30 pl-2">
            {others.map((m) => (
              <p key={m.id} className="whitespace-pre-wrap text-xs italic text-foreground/50">
                co-coder: {m.body}
              </p>
            ))}
            <textarea
              key={`${q.id}:${memo?.updated_at ?? 'new'}`}
              ref={memoRef}
              rows={5}
              defaultValue={memo?.body ?? ''}
              placeholder="Memo — what did THIS participant's answer mean, given how they solved it?"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void saveSelected();
                }
              }}
              className="w-full border border-foreground/20 bg-background px-2 py-1.5 text-sm leading-relaxed focus:border-foreground focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveSelected()}
                className="border border-foreground px-2 py-0.5 text-xs transition hover:bg-foreground hover:text-background disabled:opacity-40"
              >
                Save memo
              </button>
              <span className="text-[10px] text-foreground/40">⌘⏎ saves</span>
              {savedFor === q.id && (
                <span className="text-[10px] text-emerald-700 dark:text-emerald-400">saved ✓</span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="flex h-[80vh] flex-col overflow-y-auto rounded border border-foreground/15 p-3">
      <div className="mb-2 border-b border-foreground/15 pb-2">
        <p className="text-[10px] uppercase tracking-wide text-foreground/40">
          Retrospective · {playheadLabel} · space pauses · ←/→ ±5s
        </p>
        <h2 className="mt-0.5 text-sm font-semibold">
          {currentEpisodeName ?? 'Not in a retrospective section'}
        </h2>
        {askedQuestions.length > 0 && (
          <div className="mt-1.5 space-y-0.5">
            {askedQuestions.slice(-3).map((q) => (
              <p key={q.id} className="text-xs italic text-foreground/60">
                asked · scenario {q.scenarioIdx + 1}: &ldquo;{q.body}&rdquo;
              </p>
            ))}
          </div>
        )}
      </div>

      {bank === null ? (
        <p className="text-xs italic text-foreground/40">Loading questions…</p>
      ) : bank.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-foreground/50">
            No retrospective questions yet — seed the task&rsquo;s canonical structure
            (the scenario retrospective + the three general questions), then add
            subquestions under each.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={onSeed}
            className="border border-foreground px-2 py-1 text-xs transition hover:bg-foreground hover:text-background disabled:opacity-40"
          >
            Seed canonical questions
          </button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {bank.map((m) => (
            <div key={m.id}>
              <QuestionRow q={m} isSub={false} />
              {m.subs.map((s) => (
                <QuestionRow key={s.id} q={s} isSub />
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
                  className="ml-4 mt-0.5 text-[10px] text-foreground/40 underline-offset-2 hover:text-foreground hover:underline"
                >
                  + subquestion
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {bank !== null && bank.length > 0 && (
        <div className="mt-2 border-t border-foreground/15 pt-2">
          {addingUnder === '' ? (
            <div className="flex items-center gap-1.5">
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
              className="text-xs text-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
            >
              + main question
            </button>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </aside>
  );
}

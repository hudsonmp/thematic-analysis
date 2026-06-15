'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyRank } from '@/lib/transcript/fuzzy';

/** Minimal code shape the picker needs (flattened from the codebook tree). */
type CodeOption = { id: string; mnemonic: string; name: string };

/**
 * Coding-mode middle panel: a FUZZY code picker that applies a code at the current
 * video time (Change R12/R13).
 *
 * The researcher plays through the recording and, when they hear something to
 * code, types an APPROXIMATE description — not the exact label — into the search
 * box. `fuzzyRank` (pure, ordered-subsequence + prefix/word-boundary/contiguity
 * bonuses) ranks the codebook so the obvious match floats up: "ws" → "Writing
 * Specification", "spc" → "Specification". ↑/↓ move the cursor; Enter (or a click)
 * applies the highlighted code.
 *
 * "Links to that time": applying anchors the code to the brushed transcript
 * selection when one exists (the parent tracks it and reports it as `pending`),
 * ELSE to the cue playing at the current time — so a code always lands on the
 * moment being coded. The parent owns the apply (it has the version + selection +
 * `addAnnotation`); this panel only chooses the code and whether to use the
 * selection.
 *
 * Why fuzzy and not RAG: the codebook is small and the match is lexical (the
 * researcher half-remembers the label), so a deterministic, instant, offline
 * matcher beats an embedding round-trip — Hudson's explicit call.
 */
export default function CodingPanel({
  codes,
  currentMs,
  pending,
  applying,
  onApply,
  onClearSelection,
  formatTime,
}: {
  codes: CodeOption[];
  /** The current playhead (ms) — what an unselected apply anchors to. */
  currentMs: number;
  /** The brushed transcript selection, if any (apply anchors here when set). */
  pending: { quoteText: string; tStartMs: number } | null;
  /** True while the parent's apply is in flight (disables the controls). */
  applying: boolean;
  /** Apply `codeId` — to the selection when `useSelection`, else the current cue. */
  onApply: (codeId: string, useSelection: boolean) => void;
  onClearSelection: () => void;
  formatTime: (ms: number) => string;
}) {
  const [query, setQuery] = useState('');
  // The keyboard cursor into the ranked list (Enter applies this one).
  const [cursor, setCursor] = useState(0);
  // Previous query, tracked so we can reset the cursor DURING render when the
  // query changes (React's "store info from previous renders" pattern) instead of
  // in an effect — the repo bans setState-in-effect.
  const [prevQuery, setPrevQuery] = useState(query);
  const listRef = useRef<HTMLUListElement>(null);

  // Rank by mnemonic + name (the only fields on the client; definitions aren't
  // passed down yet — a noted limitation). Capped so a huge codebook stays snappy.
  const ranked = useMemo(
    () => fuzzyRank(query, codes, (c) => `${c.mnemonic} ${c.name}`).slice(0, 50),
    [query, codes],
  );

  // Reset the cursor to the top when the query changes (new result set). Adjusting
  // state during render is the recommended alternative to a setState-in-effect.
  if (query !== prevQuery) {
    setPrevQuery(query);
    setCursor(0);
  }

  // Keep the cursored row scrolled into view as ↑/↓ move it.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const apply = (codeId: string) => {
    if (applying) return;
    onApply(codeId, !!pending);
  };

  return (
    <section className="rounded border border-foreground/15 p-3">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">Code at</h2>
        <span className="font-mono text-xs text-foreground/60">[{formatTime(currentMs)}]</span>
      </div>

      {/* What the apply will anchor to. */}
      {pending ? (
        <div className="mb-2 rounded border border-foreground/10 bg-background/40 px-2 py-1.5 text-xs">
          <span className="text-foreground/50">selection </span>
          <span className="italic text-foreground/80">
            “{pending.quoteText.length > 80 ? pending.quoteText.slice(0, 80) + '…' : pending.quoteText}”
          </span>
          <button
            type="button"
            onClick={onClearSelection}
            className="ml-1 underline text-foreground/50 hover:text-foreground"
          >
            clear
          </button>
        </div>
      ) : (
        <p className="mb-2 text-xs text-foreground/50">
          No selection — the code anchors to the line playing now. (Brush text in
          the transcript to anchor a code to a phrase.)
        </p>
      )}

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, Math.max(0, ranked.length - 1)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const pick = ranked[cursor];
            if (pick) apply(pick.item.id);
          }
        }}
        placeholder="Describe a code… (↑/↓ then Enter)"
        aria-label="Search codes"
        autoComplete="off"
        className="mb-2 w-full rounded border border-foreground/20 bg-transparent px-2 py-1.5 text-sm"
      />

      {ranked.length === 0 ? (
        <p className="text-sm text-foreground/50">
          {codes.length === 0 ? 'No codes in the codebook yet.' : 'No matching codes.'}
        </p>
      ) : (
        <ul ref={listRef} className="max-h-[24rem] divide-y divide-foreground/10 overflow-y-auto">
          {ranked.map((m, i) => {
            const c = m.item;
            const cursored = i === cursor;
            return (
              <li key={c.id} data-row={i}>
                <button
                  type="button"
                  onClick={() => {
                    setCursor(i);
                    apply(c.id);
                  }}
                  disabled={applying}
                  className={`flex w-full items-baseline gap-2 px-1.5 py-1.5 text-left text-sm disabled:opacity-50 ${
                    cursored ? 'bg-foreground/10' : 'hover:bg-foreground/5'
                  }`}
                  title={`Apply "${c.name}"`}
                >
                  <span className="font-mono text-xs text-foreground/50">{c.mnemonic}</span>
                  <span className="flex-1">{c.name}</span>
                  {cursored && (
                    <span className="shrink-0 text-xs text-emerald-600">
                      {applying ? 'applying…' : '↵ apply'}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

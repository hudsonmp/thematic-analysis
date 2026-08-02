'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyRank } from '@/lib/transcript/fuzzy';

/** The minimum a mention needs to offer: the slug it inserts. Structural, so
 *  any richer code shape (CodeWithRefs, PopupCode, …) is passable as-is. */
export type MentionCode = { id: string; mnemonic: string };

/** The active '@' context under the caret: where the '@' sits and what has
 *  been typed after it. Null when the caret is not inside a mention. */
type Mention = { start: number; query: string };

/**
 * Find the mention the caret is inside, or null. A mention starts at an '@'
 * that begins the text or follows whitespace (so an email-ish "a@b" never
 * triggers), and the text between the '@' and the caret must be a single
 * token — any whitespace or a second '@' ends the context.
 */
function activeMention(text: string, caret: number): Mention | null {
  const at = text.lastIndexOf('@', caret - 1);
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(text[at - 1])) return null;
  const between = text.slice(at + 1, caret);
  if (/[\s@]/.test(between)) return null;
  return { start: at, query: between };
}

/**
 * A textarea that @-mentions the codebook's codes.
 *
 * Typing '@' opens a dropdown of code slugs filtered by what follows the '@'
 * (the repo's fuzzyRank, matched against the mnemonic — the code's sole
 * identifier). ↑/↓ move, ⏎ or Tab insert '@<slug> ' in place of the '@query',
 * Esc dismisses, clicking a row inserts. The dropdown renders BELOW the
 * textarea (deliberately not caret-anchored — the textareas this wraps are
 * two/three rows tall, so "below the box" and "near the caret" coincide).
 *
 * Storage stays plain text containing '@slug' tokens: no markup, no
 * linkification, nothing for the DB or the exports to know about. The codes
 * list ARRIVES AS A PROP from whichever host already holds the codebook —
 * this component never fetches.
 */
export default function MentionTextarea({
  value,
  onChange,
  codes,
  rows,
  placeholder,
  disabled,
  className,
  'aria-label': ariaLabel,
  onBlur,
}: {
  value: string;
  onChange: (next: string) => void;
  /** The mentionable codes, threaded down from the nearest host that has them. */
  codes: MentionCode[];
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  /** Fired on textarea blur (after the internal mention-popover cleanup) —
   *  lets hosts blur-commit cheap fields (e.g. a code's Notes). */
  onBlur?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<Mention | null>(null);
  const [cursor, setCursor] = useState(0);
  /** The '@' index the user Esc-dismissed — that one mention stays closed
   *  until the caret enters a different mention context. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  /** Caret position to restore after an insertion re-render. A ref, not state:
   *  restoring the caret is a DOM side effect, so the effect below consumes it
   *  without scheduling another render. */
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    if (pendingCaret.current === null) return;
    const ta = ref.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(pendingCaret.current, pendingCaret.current);
    }
    pendingCaret.current = null;
  });

  const hits = useMemo(
    () =>
      mention === null
        ? []
        : fuzzyRank(mention.query, codes, (c) => c.mnemonic)
            .slice(0, 8)
            .map((m) => m.item),
    [mention, codes],
  );

  const open = mention !== null && hits.length > 0 && dismissedAt !== mention.start;
  const safeCursor = Math.min(cursor, Math.max(hits.length - 1, 0));

  /** The last mention start seen, so entering a NEW mention context resets the
   *  focused row and clears an old Esc-dismissal. A ref (not state): it is
   *  bookkeeping for the handler, never rendered. */
  const lastStart = useRef<number | null>(null);

  /** Recompute the mention context from the DOM caret. Bound to every event
   *  that can move it (change and select) so the dropdown follows the caret
   *  rather than the last keystroke. */
  function sync(nextValue?: string) {
    const ta = ref.current;
    if (!ta) return;
    const next = activeMention(nextValue ?? ta.value, ta.selectionStart);
    if (next?.start !== lastStart.current) {
      lastStart.current = next?.start ?? null;
      setCursor(0);
    }
    if (next === null || (dismissedAt !== null && dismissedAt !== next.start)) {
      setDismissedAt(null);
    }
    // Keep the previous object when nothing changed so caret-only events
    // (clicks, arrow moves outside a mention) don't re-render the host.
    setMention((prev) =>
      prev?.start === next?.start && prev?.query === next?.query ? prev : next,
    );
  }

  function insert(code: MentionCode) {
    const ta = ref.current;
    if (!ta || mention === null) return;
    const caret = ta.selectionStart;
    const token = `@${code.mnemonic} `;
    onChange(value.slice(0, mention.start) + token + value.slice(caret));
    pendingCaret.current = mention.start + token.length;
    setMention(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insert(hits[safeCursor]);
    } else if (e.key === 'Escape') {
      // Dismiss the dropdown WITHOUT letting the Esc bubble on to whatever
      // dialog/panel hosts this textarea — one press, one dismissal.
      e.preventDefault();
      e.stopPropagation();
      setDismissedAt(mention!.start);
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        className={className}
        onChange={(e) => {
          onChange(e.target.value);
          sync(e.target.value);
        }}
        onSelect={() => sync()}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Delay so a mousedown on a dropdown row (which blurs the textarea)
          // still lands its click before the list unmounts.
          setTimeout(() => setMention(null), 150);
          onBlur?.();
        }}
      />
      {open && (
        <div
          role="listbox"
          aria-label="Mention a code"
          className="absolute left-0 top-full z-50 mt-0.5 max-h-44 w-full overflow-y-auto border border-foreground/25 bg-background shadow-xl"
        >
          {hits.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === safeCursor}
              // preventDefault on mousedown keeps focus (and the caret) in the
              // textarea so the insertion replaces the right span.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(c)}
              className={`block w-full px-2 py-1 text-left font-mono text-xs transition ${
                i === safeCursor ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.04]'
              }`}
            >
              @{c.mnemonic}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

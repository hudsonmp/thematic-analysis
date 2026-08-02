'use client';

import { useMemo, useState } from 'react';
import { fuzzyRank } from '@/lib/transcript/fuzzy';
import { splitDefinition } from '@/lib/codebook/definition';

/** What a row knows — the coding popup's PopupCode shape. The metadata fields
 *  are optional so id+mnemonic callers still work, but every real surface
 *  passes them: the hover expansion is the point of this picker. */
export type ComboCode = {
  id: string;
  mnemonic: string;
  origin?: string;
  definition?: string | null;
  exemplars?: string[];
  counterExample?: string | null;
};

/**
 * The coding screen's code picker, copied faithfully (CodingPopup rows):
 *   · SEARCH matches slug + APPLIED definition + exemplars — the code's
 *     meaning, not just its name (find a code by recalling an instance).
 *   · HOVER a row → its metadata expands in place: applied definition,
 *     exemplars, the "not:" counter-example, origin. Reading before picking.
 *   · ↑/↓ move, ⏎ picks, Esc closes; mousedown-picks so blur can't eat it.
 */
export default function CodeCombobox({
  options,
  placeholder,
  disabled,
  onPick,
}: {
  options: ComboCode[];
  placeholder: string;
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const ranked = useMemo(
    () =>
      fuzzyRank(
        query,
        options,
        (c) =>
          `${c.mnemonic} ${splitDefinition(c.definition ?? null).applied} ${(c.exemplars ?? []).join(' ')}`,
      )
        .map((m) => m.item)
        .slice(0, 50),
    [query, options],
  );
  const safeCursor = Math.min(cursor, Math.max(0, ranked.length - 1));

  const pick = (id: string) => {
    onPick(id);
    setQuery('');
    setOpen(false);
    setCursor(0);
    setHoveredId(null);
  };

  return (
    <div className="relative">
      <input
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setCursor(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so a mousedown on a row lands before the list unmounts.
          setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setCursor((c) => Math.min(c + 1, ranked.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const hit = ranked[safeCursor];
            if (hit) pick(hit.id);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        className="w-64 border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground focus:border-foreground focus:outline-none"
      />
      {open && ranked.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-0.5 max-h-[420px] w-[400px] overflow-y-auto border border-foreground/25 bg-background py-1 shadow-2xl">
          {ranked.map((c, i) => {
            const focused = i === safeCursor;
            // Same reveal contract as the coding popup: hover is transient,
            // and the focused row (keyboard) expands too.
            const expanded = hoveredId === c.id || (hoveredId === null && focused);
            return (
              <div
                key={c.id}
                onMouseEnter={() => {
                  setHoveredId(c.id);
                  setCursor(i);
                }}
                onMouseLeave={() => setHoveredId((h) => (h === c.id ? null : h))}
              >
                <button
                  type="button"
                  // mousedown, not click: fires before the input's blur closes the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(c.id);
                  }}
                  className={`block w-full px-3 py-1 text-left ${focused ? 'bg-foreground/[0.06]' : ''}`}
                >
                  <span className="font-mono text-[15px] font-medium text-foreground">
                    {c.mnemonic}
                  </span>
                </button>
                {expanded && (
                  <div className="mx-3 mb-1 border-l-2 border-foreground/15 py-0.5 pl-2 text-[13px] text-foreground/80">
                    <p>
                      {splitDefinition(c.definition ?? null).applied || <em>No definition yet.</em>}
                    </p>
                    {(c.exemplars ?? []).length > 0 && (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-foreground/70">
                        {(c.exemplars ?? []).map((ex, j) => (
                          <li key={j} className="italic">
                            “{ex}”
                          </li>
                        ))}
                      </ul>
                    )}
                    {c.counterExample && (
                      <p className="mt-1 text-foreground/70">
                        <span className="text-[11px] uppercase tracking-wide text-red-700/60 dark:text-red-400/60">
                          not:{' '}
                        </span>
                        {c.counterExample}
                      </p>
                    )}
                    {c.origin && (
                      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-foreground/35">
                        {c.origin.replace('_', ' ')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

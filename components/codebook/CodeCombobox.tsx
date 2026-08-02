'use client';

import { useMemo, useRef, useState } from 'react';
import { fuzzyRank } from '@/lib/transcript/fuzzy';

/**
 * The coding screen's code-picker pattern, extracted: type-to-search over the
 * mnemonics (fuzzy, same ranker as CodingPopup), ↑/↓ + ⏎ to pick, Esc closes.
 * A native <select> over a 60-code list makes the coder scan; search makes
 * them recall — the popup taught that lesson, so bucket membership and
 * singleton picking reuse it instead of re-learning it.
 */
export default function CodeCombobox({
  options,
  placeholder,
  disabled,
  onPick,
}: {
  options: { id: string; mnemonic: string }[];
  placeholder: string;
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const ranked = useMemo(
    () => fuzzyRank(query, options, (o) => o.mnemonic).map((m) => m.item).slice(0, 12),
    [query, options],
  );
  const safeCursor = Math.min(cursor, Math.max(0, ranked.length - 1));

  const pick = (id: string) => {
    onPick(id);
    setQuery('');
    setOpen(false);
    setCursor(0);
  };

  return (
    <div ref={rootRef} className="relative">
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
        className="w-56 border border-foreground/25 bg-background px-2 py-1 text-xs text-foreground focus:border-foreground focus:outline-none"
      />
      {open && ranked.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-0.5 max-h-64 w-72 overflow-y-auto border border-foreground/25 bg-background shadow-xl">
          {ranked.map((o, i) => (
            <button
              key={o.id}
              type="button"
              // mousedown, not click: fires before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.id);
              }}
              onMouseEnter={() => setCursor(i)}
              className={`block w-full px-2 py-1 text-left font-mono text-xs ${
                i === safeCursor ? 'bg-foreground/[0.08]' : ''
              }`}
            >
              {o.mnemonic}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

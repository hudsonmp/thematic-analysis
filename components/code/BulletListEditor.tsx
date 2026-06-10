'use client';

import { useState } from 'react';

/**
 * Reusable add / edit / remove / reorder editor over a list of strings. Fully
 * controlled: holds no internal copy of the list — every mutation calls
 * `onChange` with the next array, so the owning form is the single source of
 * truth (matters for the AnatomyEditor, which validates and submits the whole
 * draft at once). Empty strings are allowed in the working draft (a freshly
 * added row); the owner is responsible for trimming/dropping blanks on save.
 */
export default function BulletListEditor({
  items,
  onChange,
  placeholder = 'Add a clause…',
  label,
  disabled = false,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');

  function add() {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraft('');
  }
  function edit(idx: number, value: string) {
    onChange(items.map((it, i) => (i === idx ? value : it)));
  }
  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }
  function move(idx: number, delta: number) {
    const to = idx + delta;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [pulled] = next.splice(idx, 1);
    next.splice(to, 0, pulled);
    onChange(next);
  }

  return (
    <div className="space-y-1.5">
      {label && (
        <p className="text-xs uppercase tracking-wider text-foreground/50">{label}</p>
      )}
      {items.length === 0 && (
        <p className="text-xs text-foreground/30">No items yet.</p>
      )}
      <ul className="space-y-1">
        {items.map((item, idx) => (
          <li key={idx} className="flex items-center gap-1.5">
            <span className="text-foreground/30 text-xs select-none">•</span>
            <input
              value={item}
              disabled={disabled}
              onChange={(e) => edit(idx, e.target.value)}
              className="flex-1 border border-foreground/15 px-2 py-1 text-sm bg-background"
              aria-label={`${label ?? 'Item'} ${idx + 1}`}
            />
            <button
              type="button"
              disabled={disabled || idx === 0}
              onClick={() => move(idx, -1)}
              className="px-1 text-xs text-foreground/40 hover:text-foreground disabled:opacity-30"
              aria-label="Move up"
              title="Move up"
            >
              ↑
            </button>
            <button
              type="button"
              disabled={disabled || idx === items.length - 1}
              onClick={() => move(idx, 1)}
              className="px-1 text-xs text-foreground/40 hover:text-foreground disabled:opacity-30"
              aria-label="Move down"
              title="Move down"
            >
              ↓
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => remove(idx)}
              className="px-1 text-xs text-red-600 hover:underline disabled:opacity-50"
              aria-label="Remove item"
              title="Remove"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-1.5">
        <span className="text-foreground/30 text-xs select-none">+</span>
        <input
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className="flex-1 border border-foreground/15 px-2 py-1 text-sm bg-background"
          aria-label={`Add to ${label ?? 'list'}`}
        />
        <button
          type="button"
          disabled={disabled || !draft.trim()}
          onClick={add}
          className="border border-foreground/30 px-2 py-1 text-xs hover:bg-foreground hover:text-background transition disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

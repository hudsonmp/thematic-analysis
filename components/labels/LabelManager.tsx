'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createLabel,
  renameLabel,
  deleteLabel,
  reorderLabels,
} from '@/app/actions/labels';
import type { Tables } from '@/lib/types/cb-db';

type Label = Tables<'cb_labels'>;

// Fallback swatch color for labels with no color set (matches the native
// <input type=color> default so the picker and the dot agree).
const DEFAULT_SWATCH = '#000000';

/**
 * Label manager (codebook-scoped). The researcher curates the flat vocabulary
 * used to ORGANIZE/GROUP codes by theme — "Metacognition", "Surface strategy",
 * a custom theme — which a code is then tagged with (LabelTagger on the code
 * page) and the matrix can filter by. This is the categorical / "what kind"
 * axis, independent of episodes (temporal), facets, flags, and observations.
 *
 * Same shape as the flag-type editor: a list of existing labels (inline rename
 * via onBlur, recolor via a native color picker, reorder via ↑/↓, delete) plus
 * an add form. Server Actions are called from event handlers (never during
 * render) and `router.refresh()` re-runs the parent Server Component to re-fetch
 * the list. Mutations run in a transition so the panel shows a coarse "saving"
 * state and disables controls while the refresh round-trips.
 */
export default function LabelManager({
  codebookId,
  labels,
}: {
  codebookId: string;
  labels: Label[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // new-label form
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2563eb');

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Mutation failed.');
      }
    });
  }

  // Move the label at `index` by `delta` (-1 up / +1 down) and persist the new
  // order. No-op at the ends.
  function move(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= labels.length) return;
    const ids = labels.map((l) => l.id);
    [ids[index], ids[next]] = [ids[next], ids[index]];
    run(() => reorderLabels(ids));
  }

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">
          Labels{' '}
          {isPending && (
            <span className="text-sm font-normal text-foreground/40">· saving…</span>
          )}
        </h1>
        <p className="text-sm text-foreground/60">
          A flat vocabulary for organizing codes by theme (e.g.
          “Metacognition”, “Surface strategy”). Give each a color so it reads at
          a glance; tag codes with labels on the code page, then filter the
          matrix by label.
        </p>
      </header>

      {error && (
        <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {/* Existing labels */}
      {labels.length === 0 ? (
        <p className="mb-6 text-sm text-foreground/50">
          No labels yet. Add one below.
        </p>
      ) : (
        <ul className="mb-6 divide-y divide-foreground/10 border border-foreground/15">
          {labels.map((lbl, i) => (
            <li key={lbl.id} className="flex items-center gap-2 px-3 py-2">
              <span className="w-6 font-mono text-xs text-foreground/40">
                {i + 1}.
              </span>
              <input
                type="color"
                value={lbl.color ?? DEFAULT_SWATCH}
                disabled={isPending}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== (lbl.color ?? DEFAULT_SWATCH)) {
                    run(() => renameLabel(lbl.id, { name: lbl.name, color: v }));
                  }
                }}
                className="h-7 w-7 cursor-pointer border border-foreground/15 bg-background p-0.5"
                aria-label={`Color for ${lbl.name}`}
                title="Pick color"
              />
              <input
                defaultValue={lbl.name}
                disabled={isPending}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== lbl.name) run(() => renameLabel(lbl.id, { name: v }));
                }}
                className="flex-1 border border-foreground/15 bg-background px-2 py-1 text-sm"
                aria-label={`Rename label ${lbl.name}`}
              />
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={isPending || i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${lbl.name} up`}
                  title="Move up"
                  className="px-1 text-foreground/40 hover:text-foreground disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={isPending || i === labels.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${lbl.name} down`}
                  title="Move down"
                  className="px-1 text-foreground/40 hover:text-foreground disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    if (confirm(`Delete label "${lbl.name}"?`)) {
                      run(() => deleteLabel(lbl.id));
                    }
                  }}
                  aria-label={`Delete label ${lbl.name}`}
                  className="px-1 text-red-600 hover:underline disabled:opacity-50"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add label */}
      <div className="border-t border-foreground/10 pt-4">
        <p className="mb-2 text-xs uppercase tracking-wider text-foreground/50">
          New label
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-foreground/50">name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Metacognition"
              disabled={isPending}
              className="w-56 border border-foreground/15 bg-background px-2 py-1 text-sm"
              aria-label="New label name"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-foreground/50">color</span>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              disabled={isPending}
              className="h-8 w-12 cursor-pointer border border-foreground/15 bg-background p-0.5"
              aria-label="New label color"
            />
          </label>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              const n = name.trim();
              if (!n) {
                setError('Label needs a name.');
                return;
              }
              run(async () => {
                await createLabel(codebookId, { name: n, color });
                setName('');
                setColor('#2563eb');
              });
            }}
            className="border border-foreground px-3 py-1 text-sm transition hover:bg-foreground hover:text-background disabled:opacity-50"
          >
            Add label
          </button>
        </div>
      </div>
    </main>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createFlagType,
  renameFlagType,
  deleteFlagType,
  reorderFlagTypes,
} from '@/app/actions/flag-types';
import type { Tables } from '@/lib/types/cb-db';

type FlagType = Tables<'cb_flag_types'>;

// Fallback swatch color for flags with no color set (matches the native
// <input type=color> default so the picker and the dot agree).
const DEFAULT_SWATCH = '#000000';

/**
 * Flag-taxonomy manager (codebook-scoped). The researcher curates the named,
 * color-tagged flags a co-observer can raise during a live session — "Confusion",
 * "Aha", "Off-task" — which a later task will pin at a live timecode.
 *
 * Same shape as the episode editor: a list of existing flag types (inline rename
 * via onBlur, recolor via a native color picker, reorder via ↑/↓, delete) plus an
 * add form. Server Actions are called from event handlers (never during render)
 * and `router.refresh()` re-runs the parent Server Component to re-fetch the list.
 * Mutations run in a transition so the panel shows a coarse "saving" state and
 * disables controls while the refresh round-trips.
 */
export default function FlagTypeManager({
  codebookId,
  flagTypes,
}: {
  codebookId: string;
  flagTypes: FlagType[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // new-flag form
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('#c0392b');

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

  // Move the flag at `index` by `delta` (-1 up / +1 down) and persist the new
  // order. No-op at the ends.
  function move(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= flagTypes.length) return;
    const ids = flagTypes.map((f) => f.id);
    [ids[index], ids[next]] = [ids[next], ids[index]];
    run(() => reorderFlagTypes(ids));
  }

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">
          Flags{' '}
          {isPending && (
            <span className="text-sm font-normal text-foreground/40">· saving…</span>
          )}
        </h1>
        <p className="text-sm text-foreground/60">
          Preset the flags a co-observer can raise during a live session (e.g.
          “Confusion”, “Aha”, “Off-task”). Give each a color so it reads at a
          glance; a later step pins these at a live timecode.
        </p>
      </header>

      {error && (
        <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {/* Existing flag types */}
      {flagTypes.length === 0 ? (
        <p className="mb-6 text-sm text-foreground/50">
          No flag types yet. Add one below.
        </p>
      ) : (
        <ul className="mb-6 divide-y divide-foreground/10 border border-foreground/15">
          {flagTypes.map((ft, i) => (
            <li key={ft.id} className="flex items-center gap-2 px-3 py-2">
              <span className="w-6 font-mono text-xs text-foreground/40">
                {i + 1}.
              </span>
              <input
                type="color"
                value={ft.color ?? DEFAULT_SWATCH}
                disabled={isPending}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== (ft.color ?? DEFAULT_SWATCH)) {
                    run(() => renameFlagType(ft.id, { label: ft.label, color: v }));
                  }
                }}
                className="h-7 w-7 cursor-pointer border border-foreground/15 bg-background p-0.5"
                aria-label={`Color for ${ft.label}`}
                title="Pick color"
              />
              <input
                defaultValue={ft.label}
                disabled={isPending}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== ft.label) run(() => renameFlagType(ft.id, { label: v }));
                }}
                className="flex-1 border border-foreground/15 bg-background px-2 py-1 text-sm"
                aria-label={`Rename flag ${ft.label}`}
              />
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={isPending || i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${ft.label} up`}
                  title="Move up"
                  className="px-1 text-foreground/40 hover:text-foreground disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={isPending || i === flagTypes.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${ft.label} down`}
                  title="Move down"
                  className="px-1 text-foreground/40 hover:text-foreground disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    if (confirm(`Delete flag "${ft.label}"?`)) {
                      run(() => deleteFlagType(ft.id));
                    }
                  }}
                  aria-label={`Delete flag ${ft.label}`}
                  className="px-1 text-red-600 hover:underline disabled:opacity-50"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add flag type */}
      <div className="border-t border-foreground/10 pt-4">
        <p className="mb-2 text-xs uppercase tracking-wider text-foreground/50">
          New flag
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-foreground/50">label</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Confusion"
              disabled={isPending}
              className="w-56 border border-foreground/15 bg-background px-2 py-1 text-sm"
              aria-label="New flag label"
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
              aria-label="New flag color"
            />
          </label>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              const l = label.trim();
              if (!l) {
                setError('Flag needs a label.');
                return;
              }
              run(async () => {
                await createFlagType(codebookId, { label: l, color });
                setLabel('');
                setColor('#c0392b');
              });
            }}
            className="border border-foreground px-3 py-1 text-sm transition hover:bg-foreground hover:text-background disabled:opacity-50"
          >
            Add flag
          </button>
        </div>
      </div>
    </main>
  );
}

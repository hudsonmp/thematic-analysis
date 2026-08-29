'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createEpisode,
  renameEpisode,
  deleteEpisode,
  reorderEpisodes,
} from '@/app/actions/episodes';
import type { Tables } from '@/lib/types/cb-db';

type Episode = Tables<'cb_episodes'>;

/**
 * Preset-episodes manager (codebook-scoped). The researcher curates the named
 * phases of a session here — "Scenario 1 read", "revise", a custom phase — which
 * the session player then offers as marks to pin at a video timecode for
 * navigation/resumability.
 *
 * Same shape as the facet editor: a list of existing episodes (inline rename via
 * onBlur, reorder via ↑/↓, delete) plus an add form. Server Actions are called
 * from event handlers (never during render) and `router.refresh()` re-runs the
 * parent Server Component to re-fetch the list. Mutations run in a transition so
 * the panel shows a coarse "saving" state and disables controls while the
 * refresh round-trips.
 */
export default function EpisodeManager({
  codebookId,
  episodes,
}: {
  codebookId: string;
  episodes: Episode[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // new-episode form
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

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

  // Move the episode at `index` by `delta` (-1 up / +1 down) and persist the new
  // order. No-op at the ends.
  function move(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= episodes.length) return;
    const ids = episodes.map((e) => e.id);
    [ids[index], ids[next]] = [ids[next], ids[index]];
    run(() => reorderEpisodes(ids));
  }

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">
          Events{' '}
          {isPending && (
            <span className="text-sm font-normal text-foreground/40">· saving…</span>
          )}
        </h1>
      </header>

      {error && (
        <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {/* Existing episodes */}
      {episodes.length === 0 ? (
        <p className="mb-6 text-sm text-foreground/50">
          No preset events yet. Add one below.
        </p>
      ) : (
        <ul className="mb-6 divide-y divide-foreground/10 border border-foreground/15">
          {episodes.map((ep, i) => (
            <li key={ep.id} className="flex items-center gap-2 px-3 py-2">
              <span className="w-6 font-mono text-xs text-foreground/40">
                {i + 1}.
              </span>
              <div className="flex flex-1 flex-col gap-1">
                <input
                  defaultValue={ep.name}
                  disabled={isPending}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== ep.name) run(() => renameEpisode(ep.id, { name: v }));
                  }}
                  className="border border-foreground/15 bg-background px-2 py-1 text-sm"
                  aria-label={`Rename event ${ep.name}`}
                />
                <input
                  defaultValue={ep.description ?? ''}
                  disabled={isPending}
                  placeholder="description (optional)"
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v.trim() !== (ep.description ?? '').trim()) {
                      run(() => renameEpisode(ep.id, { name: ep.name, description: v }));
                    }
                  }}
                  className="border border-foreground/10 bg-background px-2 py-1 text-xs text-foreground/70"
                  aria-label={`Description for ${ep.name}`}
                />
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={isPending || i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${ep.name} up`}
                  title="Move up"
                  className="px-1 text-foreground/40 hover:text-foreground disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={isPending || i === episodes.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${ep.name} down`}
                  title="Move down"
                  className="px-1 text-foreground/40 hover:text-foreground disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    if (confirm(`Delete event "${ep.name}" and its session marks?`)) {
                      run(() => deleteEpisode(ep.id));
                    }
                  }}
                  aria-label={`Delete event ${ep.name}`}
                  className="px-1 text-red-600 hover:underline disabled:opacity-50"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add episode */}
      <div className="border-t border-foreground/10 pt-4">
        <p className="mb-2 text-xs uppercase tracking-wider text-foreground/50">
          New event
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-foreground/50">name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Scenario 1 read"
              disabled={isPending}
              className="w-56 border border-foreground/15 bg-background px-2 py-1 text-sm"
              aria-label="New event name"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-foreground/50">
              description <span className="text-foreground/35">— optional</span>
            </span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="participant first reads the scenario"
              disabled={isPending}
              className="w-72 border border-foreground/15 bg-background px-2 py-1 text-sm"
              aria-label="New event description"
            />
          </label>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              const n = name.trim();
              if (!n) {
                setError('Event needs a name.');
                return;
              }
              run(async () => {
                await createEpisode(codebookId, {
                  name: n,
                  description: description.trim() || undefined,
                });
                setName('');
                setDescription('');
              });
            }}
            className="border border-foreground px-3 py-1 text-sm transition hover:bg-foreground hover:text-background disabled:opacity-50"
          >
            Add event
          </button>
        </div>
      </div>
    </main>
  );
}

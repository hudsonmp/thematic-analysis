'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setCodeEpisodes } from '@/app/actions/codes';
import type { Tables } from '@/lib/types/cb-db';

type Episode = Tables<'cb_episodes'>;

/**
 * Episode-tag editor for a code (Feature #10). Checkbox-style toggles over the
 * codebook's PRESET episodes (cb_episodes) marking which protocol episodes the
 * code pertains to — orthogonal to facet classification and to per-session
 * episode marks. Every toggle recomputes the FULL selected set and calls
 * `setCodeEpisodes(codeId, allIds)` (the action replaces the whole set), then
 * router.refresh() so the matrix episode filter re-reads. Selection is held in
 * local state for snappy feedback, seeded from `selectedEpisodeIds`, and rolled
 * back to server truth on error. Mirrors FacetTagger's multi-cardinality path.
 */
export default function EpisodeTagger({
  codeId,
  episodes,
  selectedEpisodeIds,
}: {
  codeId: string;
  episodes: Episode[];
  selectedEpisodeIds: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(selectedEpisodeIds));

  function commit(next: Set<string>) {
    setSelected(next);
    setError(null);
    startTransition(async () => {
      try {
        await setCodeEpisodes(codeId, [...next]);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save event tags.');
        setSelected(new Set(selectedEpisodeIds)); // roll back to server truth
      }
    });
  }

  function toggle(episodeId: string) {
    const next = new Set(selected);
    if (next.has(episodeId)) next.delete(episodeId);
    else next.add(episodeId);
    commit(next);
  }

  if (episodes.length === 0) {
    return (
      <p className="text-sm text-foreground/50">
        No events defined yet — add preset events on the Events page to tag this code.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-1.5">
        {episodes.map((ep) => {
          const isOn = selected.has(ep.id);
          return (
            <button
              key={ep.id}
              type="button"
              disabled={isPending}
              onClick={() => toggle(ep.id)}
              aria-pressed={isOn}
              title={ep.description ?? undefined}
              className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs transition disabled:opacity-50 ${
                isOn
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-foreground/20 hover:border-foreground'
              }`}
            >
              {ep.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { getOrCreateCodebook } from '@/app/actions/codebook';
import { listEpisodes } from '@/app/actions/episodes';
import EpisodeManager from '@/components/episodes/EpisodeManager';

/**
 * The preset-episodes manager page. A Server Component: it resolves the codebook
 * and loads its preset episodes, then hands both to the client `EpisodeManager`.
 * No Server Actions are invoked during client render — the client calls them
 * from event handlers and `router.refresh()`es to re-run this loader.
 */
export default async function EpisodesPage() {
  const cb = await getOrCreateCodebook();
  const episodes = await listEpisodes(cb.id);

  return <EpisodeManager codebookId={cb.id} episodes={episodes} />;
}

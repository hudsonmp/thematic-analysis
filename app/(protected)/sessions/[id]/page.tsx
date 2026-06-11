import { getSessionCloud } from '@/app/actions/sessions';
import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { listMyAnnotations } from '@/app/actions/annotations';
import { listEpisodes, listSessionEpisodes } from '@/app/actions/episodes';
import { getAuthUser } from '@/lib/auth/supabase-auth';
import SessionPlayer from '@/components/sessions/SessionPlayer';

/**
 * The per-session player page. Next 16: `params` is a Promise, so we await it.
 * The session is loaded from the cloud via `getSessionCloud(id)` (the
 * `cb_sessions` row + its original `cb_segments`); a missing id 404s inside that
 * action. The player streams the video from the same-origin
 * `/api/media/<id>/video` route, which 302-redirects to a short-lived signed
 * Storage URL the researcher cookie authorizes.
 *
 * Coding is now wired (Task 9): we load the codebook's codes (flattened to the
 * picker shape) and the signed-in coder's OWN annotations (`listMyAnnotations`,
 * own-coding isolation) and pass them with `codingEnabled`. The coder is
 * implicit — every annotation is owned by `auth.uid()`, so there is no coder
 * input in the UI. Comments (`cb_memos`) remain hidden pending their own
 * migration.
 *
 * Realtime (Task 10): we also pass the signed-in coder's `auth.uid()` (`myUid`)
 * so the player's `useRealtimeAnnotations` hook can scope live sync to the
 * coder's OWN rows — when they add/delete an annotation in another tab/device,
 * this page's rail updates live (a debounced `router.refresh()` re-runs this
 * server component and re-passes `myAnnotations` with joined codes).
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [session, codebook, myAnnotations, sessionEpisodes, user] = await Promise.all([
    getSessionCloud(id),
    getOrCreateCodebook(),
    listMyAnnotations(id),
    listSessionEpisodes(id),
    getAuthUser(),
  ]);

  // The codebook tree (for the code picker) and the codebook's preset episodes
  // (for the assign-during-coding control) both key off the resolved codebook id.
  const [tree, episodes] = await Promise.all([
    listCodebookTree(codebook.id),
    listEpisodes(codebook.id),
  ]);

  // Flatten the codebook tree to the minimal `{id, mnemonic, name}` the code
  // picker consumes.
  const codes = tree.codes.map((c) => ({
    id: c.id,
    mnemonic: c.mnemonic,
    name: c.name,
  }));

  return (
    <SessionPlayer
      id={session.id}
      pidLabel={session.pidLabel}
      segments={session.segments}
      durationMs={session.durationMs ?? 0}
      codingEnabled
      versionId={session.versionId}
      codes={codes}
      myAnnotations={myAnnotations}
      myUid={user?.id ?? null}
      episodes={episodes.map((e) => ({ id: e.id, name: e.name }))}
      sessionEpisodes={sessionEpisodes}
      compareHref={`/sessions/${session.id}/compare`}
    />
  );
}

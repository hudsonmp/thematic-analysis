import { getSessionCloud } from '@/app/actions/sessions';
import SessionPlayer from '@/components/sessions/SessionPlayer';

/**
 * The per-session player page. Next 16: `params` is a Promise, so we await it.
 * The session is loaded from the cloud via `getSessionCloud(id)` (the
 * `cb_sessions` row + its original `cb_segments`); a missing id 404s inside that
 * action. The player streams the video from the same-origin
 * `/api/media/<id>/video` route, which 302-redirects to a short-lived signed
 * Storage URL the researcher cookie authorizes.
 *
 * Coding/comments are intentionally NOT wired here: that UI is hidden in
 * `SessionPlayer` pending the `cb_annotations` migration (Task 9), so this page
 * passes only the playback + transcript props.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionCloud(id);

  return (
    <SessionPlayer
      id={session.id}
      pidLabel={session.pidLabel}
      segments={session.segments}
      durationMs={session.durationMs ?? 0}
    />
  );
}

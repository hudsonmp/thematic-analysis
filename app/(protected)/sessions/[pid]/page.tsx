import { notFound } from 'next/navigation';
import { getSession } from '@/lib/sessions/discover';
import SessionPlayer from '@/components/sessions/SessionPlayer';

/**
 * The per-session player page. Next 16: `params` is a Promise, so we await it.
 * We load the session via `getSession(pid)` (wrapped in try/catch — an invalid
 * or unknown pid throws, which we map to a 404), then hand the segments and
 * metadata to the client `SessionPlayer`. The player streams the video from the
 * same-origin `/api/media/<pid>/video` route, which the researcher cookie
 * authorizes automatically; no Server Action is invoked during client render.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ pid: string }>;
}) {
  const { pid } = await params;

  let session;
  try {
    session = await getSession(pid);
  } catch {
    notFound();
  }

  const { segments, firstName, durationMs } = session;

  return (
    <SessionPlayer
      pid={pid}
      firstName={firstName}
      segments={segments}
      durationMs={durationMs}
    />
  );
}

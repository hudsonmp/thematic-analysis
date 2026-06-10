import { notFound } from 'next/navigation';
import { getSession } from '@/lib/sessions/discover';
import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { listCodings } from '@/app/actions/codings';
import { listMemos } from '@/app/actions/memos';
import SessionPlayer from '@/components/sessions/SessionPlayer';

/**
 * The per-session player page. Next 16: `params` is a Promise, so we await it.
 * We load the session via `getSession(pid)` (wrapped in try/catch — an invalid
 * or unknown pid throws, which we map to a 404), then load the bound codebook,
 * its codes (flattened to {id,mnemonic,name}), and any existing codings/memos
 * for this recording. All of this is handed to the client `SessionPlayer`. The
 * player streams the video from the same-origin `/api/media/<pid>/video` route,
 * which the researcher cookie authorizes automatically. Mutations run through
 * Server Actions from event handlers (never during client render), followed by
 * `router.refresh()` to re-load codings/memos here on the server.
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

  const { segments, firstName, durationMs, userId, studyId } = session;

  // The codebook is bound to the shown study; this is idempotent. Flatten the
  // codebook tree's codes to the minimal shape the picker needs.
  const codebook = await getOrCreateCodebook();
  const [tree, codings, memos] = await Promise.all([
    listCodebookTree(codebook.id),
    listCodings(pid),
    listMemos(pid),
  ]);

  const codes = tree.codes.map((c) => ({
    id: c.id,
    mnemonic: c.mnemonic,
    name: c.name,
  }));

  return (
    <SessionPlayer
      pid={pid}
      firstName={firstName}
      segments={segments}
      durationMs={durationMs}
      userId={userId}
      studyId={studyId}
      codebookId={codebook.id}
      codes={codes}
      codings={codings}
      memos={memos}
    />
  );
}

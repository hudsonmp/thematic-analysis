import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getSessionCloud } from '@/app/actions/sessions';
import { listAllAnnotations, listCanonical } from '@/app/actions/annotations';
import { listSessionSpecTimeline } from '@/app/actions/spec';
import CompareView from '@/components/sessions/CompareView';

/**
 * /sessions/[id]/compare — the post-hoc PAIRWISE overlay: MY coding beside ONE
 * chosen other coder's, per transcript segment, plus a Specification tab showing
 * the participant's final spec as shared context.
 *
 * Deliberately pairwise rather than the old every-coder matrix: reconciliation is
 * a conversation between two codings at a time, and N columns of chips turn a diff
 * into a spreadsheet. The full coder list still loads (the picker chooses from it,
 * and canonical candidates stay the ALL-coder union so canonizing never
 * under-offers a code from an unselected coder).
 *
 * The viewer's uid is threaded down so the client can split "mine" from "theirs" —
 * requireAuthUser() alone never reached the client before, which is why the old
 * matrix could not tell the viewer apart from their colleagues.
 *
 * Independent coding stays quarantined to the own-coding page; this surface is
 * read-only per coder, writable only in the Canonical lane.
 */
export default async function ComparePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireAuthUser();

  const [session, { annotations, coders }, canonical] = await Promise.all([
    getSessionCloud(id),
    listAllAnnotations(id),
    listCanonical(id),
  ]);

  // The participant's spec-edit stream — replayed to its FINAL state client-side
  // (compare has no playhead, so "the spec they ended with" is the useful instant).
  // Tolerant of sessions with no spec data: the tab then explains itself.
  let specTimeline: Awaited<ReturnType<typeof listSessionSpecTimeline>> = {
    specEdits: [],
    entityEdits: [],
  };
  try {
    specTimeline = await listSessionSpecTimeline(id);
  } catch {
    /* no spec stream for this session — the Specification tab shows an empty state */
  }

  return (
    <CompareView
      sessionId={session.id}
      versionId={session.versionId}
      pidLabel={session.pidLabel}
      segments={session.segments}
      annotations={annotations}
      coders={coders}
      canonical={canonical}
      myUid={user.id}
      specTimeline={specTimeline}
    />
  );
}

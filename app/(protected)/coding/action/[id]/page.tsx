import { getSessionCloud, getSessionVersions } from '@/app/actions/sessions';
import { getOrCreateCodebook } from '@/app/actions/codebook';
import { getActionSchema } from '@/app/actions/action-schema';
import {
  getMyActionUsage,
  listMyActionAnnotationsForVersion,
  listActionAnnotationComments,
} from '@/app/actions/action-coding';
import { listSessionEpisodes, materializeAutoEpisodes } from '@/app/actions/episodes';
import { taskStartForPid } from '@/app/actions/live';
import { getRecordingStart } from '@/app/actions/recording';
import { listObservationsForSession } from '@/app/actions/observations';
import { listSessionAssistantChat } from '@/app/actions/chat';
import { listSessionSpecTimeline } from '@/app/actions/spec';
import { getAuthUser } from '@/lib/auth/supabase-auth';
import { getMyRole } from '@/lib/auth/roles';
import SessionPlayer from '@/components/sessions/SessionPlayer';

/**
 * /coding/action/[id] — the ACTION-layer player. Same page as /sessions/[id]
 * (same auth, video, transcript layers, highlighting, flags, chat/spec replay),
 * with ONE difference: the player runs on `layer="action"`, so its spans live in
 * cb_action_annotations, its popup lists ACTIONS (moves × objects) from
 * /actions, and its chips are action codings. The codebook layer is never read
 * or written from here.
 */
export default async function ActionCodingSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  try {
    await materializeAutoEpisodes(id);
  } catch {
    // Non-fatal: derivation failures must not break the page.
  }

  const role = await getMyRole();
  const [session, versions, codebook, sessionEpisodes, observations, user] = await Promise.all([
    getSessionCloud(id),
    getSessionVersions(id),
    getOrCreateCodebook(),
    listSessionEpisodes(id),
    listObservationsForSession(id),
    getAuthUser(),
  ]);

  let chatMessages: Awaited<ReturnType<typeof listSessionAssistantChat>> = [];
  try {
    chatMessages = await listSessionAssistantChat(id);
  } catch {
    // Non-fatal.
  }
  let specTimeline: Awaited<ReturnType<typeof listSessionSpecTimeline>> = {
    specEdits: [],
    entityEdits: [],
  };
  try {
    specTimeline = await listSessionSpecTimeline(id);
  } catch {
    // Non-fatal.
  }

  // The action vocabulary + catalog (the popup's instrument) and this coder's
  // own ACTION-layer annotations on the loaded version.
  const [actionSchema, actionUsage, myAnnotations] = await Promise.all([
    getActionSchema(codebook.id),
    // Cross-session usage for the picker's recent/frequent tie-break; THIS
    // session's codings are folded in live from the player's state.
    getMyActionUsage(id).catch(() => ({})),
    session.versionId ? listMyActionAnnotationsForVersion(id, session.versionId, codebook.id) : Promise.resolve([]),
  ]);
  const comments =
    myAnnotations.length > 0
      ? await listActionAnnotationComments(myAnnotations.map((a) => a.id))
      : {};

  const effectiveAnchor =
    (await getRecordingStart(session.pidLabel)) ??
    observations.recordingStartedAt ??
    (await taskStartForPid(session.pidLabel));

  return (
    <SessionPlayer
      id={session.id}
      pidLabel={session.pidLabel}
      segments={session.segments}
      durationMs={session.durationMs ?? 0}
      codingEnabled={role !== 'viewer'}
      canComment
      versionId={session.versionId}
      versions={versions}
      codes={[]}
      myAnnotations={myAnnotations}
      comments={comments}
      myUid={user?.id ?? null}
      sessionEpisodes={sessionEpisodes}
      observations={observations.observations}
      chatMessages={chatMessages}
      specTimeline={specTimeline}
      recordingStartedAt={effectiveAnchor}
      codebookId={codebook.id}
      collection={session.collection ?? null}
      compareHref={null}
      layer="action"
      actionSchema={actionSchema}
      actionUsage={actionUsage}
    />
  );
}

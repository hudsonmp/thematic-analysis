import { getSessionCloud, getSessionVersions } from '@/app/actions/sessions';
import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import {
  listMyAnnotationsForVersion,
  listAnnotationComments,
} from '@/app/actions/annotations';
import {
  listEpisodes,
  listSessionEpisodes,
  materializeAutoEpisodes,
} from '@/app/actions/episodes';
import { taskStartForPid } from '@/app/actions/live';
import { listObservationsForSession } from '@/app/actions/observations';
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
 *
 * Review markers (Task 5, live co-observation): we also load this session's
 * PID's live observations + the recording anchor (`listObservationsForSession`)
 * and pass them to the player, which renders each as a clickable marker on the
 * time rail at `createdAt − recordingStartedAt` and lists them in a Flags rail.
 * Read-only here — observations are created on the live screen (`/sessions/live`).
 *
 * Transcript layers (feature #20): a session has an ORIGINAL (verbatim ASR)
 * version and, once the researcher creates it, a CLEANED copy. The page opens on
 * the ORIGINAL (the default `getSessionCloud(id)` loads) and passes the full
 * version list so the player can render Original/Cleaned tabs. Annotations are
 * version-scoped (`listMyAnnotationsForVersion`) — the original's own
 * annotations are the initial server-rendered set; switching tabs re-loads the
 * other version's segments + annotations client-side.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Auto-derive episode marks from the participant's task timeline (Task 2/5)
  // BEFORE reading them, so the page reflects the freshly-materialized marks.
  // Non-fatal: a derivation failure (e.g. no anchor / no task clock) must not
  // break the page — we still render with whatever marks already exist.
  try {
    await materializeAutoEpisodes(id);
  } catch {
    // Non-fatal: derivation failures must not break the page.
  }

  const [session, versions, codebook, sessionEpisodes, observations, user] =
    await Promise.all([
      getSessionCloud(id),
      getSessionVersions(id),
      getOrCreateCodebook(),
      // Read AFTER materializeAutoEpisodes so the navigable timeline reflects
      // the just-derived marks (not a stale, pre-derivation snapshot).
      listSessionEpisodes(id),
      // Live co-observation review markers (Task 5): this session's PID's
      // observations + the `recording_started_at` anchor for offset math. The
      // action resolves the PID via `cb_sessions.pid_label` and joins flag
      // types (label + color); `recordingStartedAt` is null when the recording
      // was never anchored (the player then renders an "anchor not set" hint).
      listObservationsForSession(id),
      getAuthUser(),
    ]);

  // Initial (server-rendered) annotations are the ORIGINAL version's own
  // annotations — version-scoped so highlights anchor to the loaded text. A
  // session with no original version (pathological half-ingest) has no version
  // to scope by, so the rail starts empty.
  const myAnnotations = session.versionId
    ? await listMyAnnotationsForVersion(id, session.versionId)
    : [];

  // Per-excerpt comment threads (#17/#18) for the ORIGINAL version's visible
  // annotations, loaded in ONE call and grouped by annotation id. The player
  // opens a thread when its highlight is clicked; switching tabs re-loads the
  // other version's threads client-side.
  const comments =
    myAnnotations.length > 0
      ? await listAnnotationComments(myAnnotations.map((a) => a.id))
      : {};

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

  // Effective recording anchor (Task 5): PREFER the manual recording mark
  // (`observations.recordingStartedAt`); FALL BACK to the participant's task
  // start (earliest `module_start`) when no mark was set. Passing this as the
  // player's `recordingStartedAt` makes live flags place at `createdAt −
  // taskStart` even with no manual mark — the same anchor the auto-episode
  // derivation uses, so flags and derived episodes share one clock.
  const effectiveAnchor =
    observations.recordingStartedAt ?? (await taskStartForPid(session.pidLabel));

  return (
    <SessionPlayer
      id={session.id}
      pidLabel={session.pidLabel}
      segments={session.segments}
      durationMs={session.durationMs ?? 0}
      codingEnabled
      versionId={session.versionId}
      versions={versions}
      codes={codes}
      myAnnotations={myAnnotations}
      comments={comments}
      myUid={user?.id ?? null}
      episodes={episodes.map((e) => ({ id: e.id, name: e.name }))}
      sessionEpisodes={sessionEpisodes}
      observations={observations.observations}
      recordingStartedAt={effectiveAnchor}
      codebookId={codebook.id}
      facets={tree.facets}
      collection={session.collection ?? null}
      compareHref={`/sessions/${session.id}/compare`}
    />
  );
}

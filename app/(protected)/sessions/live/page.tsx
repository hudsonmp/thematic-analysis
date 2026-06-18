import { getOrCreateCodebook } from '@/app/actions/codebook';
import { listFlagTypes } from '@/app/actions/flag-types';
import { listObservationsForPid } from '@/app/actions/observations';
import { listParticipants, liveStatusForPid } from '@/app/actions/live';
import LiveFollow from '@/components/live/LiveFollow';

/**
 * The Live Follow view (server). A minimal in-the-moment note-capture surface:
 * while a participant works, the researcher picks them by PID, watches their
 * current step + a running clock, and taps one-tap flags (optionally with a
 * note). No video here — the rich timeline is reconstructed at review (Task 5).
 *
 * Server Component. It resolves the active codebook's flag taxonomy, the
 * participant list, and — when a `?pid=` is present — that PID's existing
 * observations plus an initial live status (so the first paint already shows the
 * current step + clock before the client's first poll). The active PID lives in
 * the URL (`?pid=`) so a reload resumes on the same participant.
 *
 * Next 16: `searchParams` is a Promise and MUST be awaited (a request-time API
 * that opts this route into dynamic rendering — which is correct, the live
 * stream is request-time data).
 */
export default async function LiveFollowPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { pid: pidParam } = await searchParams;
  // `?pid=` may arrive as a string or (if repeated) a string[]; take the first.
  const pid =
    typeof pidParam === 'string'
      ? pidParam
      : Array.isArray(pidParam)
        ? pidParam[0] ?? ''
        : '';

  const cb = await getOrCreateCodebook();

  // Flag taxonomy + participant list are PID-independent; load them always. The
  // codebook id rides through so the live page can inline-create flags
  // (createFlagType is codebook-scoped).
  const [flagTypes, participants] = await Promise.all([
    listFlagTypes(cb.id),
    listParticipants(),
  ]);

  // PID-scoped initial data: this participant's observations and the first live
  // status (current step + clock anchors + manual recording mark). Skipped when no
  // PID is selected.
  const [observations, initialStatus] = pid
    ? await Promise.all([listObservationsForPid(pid), liveStatusForPid(pid)])
    : [
        [],
        {
          stepLabel: null,
          latestAt: null,
          taskStartedAt: null,
          taskEndedAt: null,
          recordingStartedAt: null,
          scenarioCount: 0,
          phaseStartsMs: { scenarios: [] },
        },
      ];

  return (
    // key={pid} remounts LiveFollow on a participant switch so its local state
    // (status / observations) re-seeds from the fresh server props for the new
    // PID — no prop→state sync effect needed.
    <LiveFollow
      key={pid || '__none__'}
      pid={pid}
      codebookId={cb.id}
      participants={participants}
      flagTypes={flagTypes}
      initialObservations={observations}
      initialStatus={initialStatus}
    />
  );
}

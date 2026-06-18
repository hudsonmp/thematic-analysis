'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addObservation,
  deleteObservation,
  type ObservationView,
} from '@/app/actions/observations';
import { liveStatusForPid, type LiveStatus, type LiveParticipant } from '@/app/actions/live';
import { markRecordingStart, clearRecordingStart } from '@/app/actions/recording';
import { createFlagType } from '@/app/actions/flag-types';
import {
  formatElapsed,
  formatDate,
  observationTime,
  resolveClockStart,
} from '@/lib/live/clock';
import {
  computeTimer,
  formatRemaining,
  REQUIREMENTS_BUDGET_MS,
  SCENARIO_BUDGET_MS,
} from '@/lib/live/countdown';
import { createBrowser } from '@/lib/supabase/browser';
import type { Tables } from '@/lib/types/cb-db';

type FlagType = Tables<'cb_flag_types'>;

const POLL_MS = 3000;
const DEFAULT_SWATCH = '#000000';

// ---------------------------------------------------------------------------
// Researcher → participant push (T2). CROSS-REPO CONTRACT — the spec-study-app
// receiver subscribes to a PUBLIC broadcast channel `live:participant:<pid>` and
// listens for exactly these event names. Do NOT rename either.
//
// PUBLIC (not private) broadcast: on this project `realtime.messages` has RLS
// enabled with zero policies, so AUTHORIZED channels are blocked; public
// broadcast does not consult that RLS and works for both the authed researcher
// client and the anon participant client. A broadcast send writes NO DB row, so
// the study-table read-only invariant (check-no-study-writes) is preserved.
// ---------------------------------------------------------------------------

/** The kinds of researcher-pushed popup. `show_time` → participant shows ITS OWN
 *  computed cumulative remaining; `offer_help` → participant gets an "open
 *  assistant" popup. */
export type PushKind = 'show_time' | 'offer_help';

/** The broadcast channel a participant `pid` listens on. */
function participantChannel(pid: string): string {
  return `live:participant:${pid}`;
}

/** PURE seam (tested): the `{ event, payload }` for a push. The event name is the
 *  cross-repo contract; the payload is intentionally empty — the participant
 *  computes the number locally, so nothing sensitive crosses the wire. */
export function buildPushPayload(kind: PushKind): {
  event: PushKind;
  payload: Record<string, never>;
} {
  return { event: kind, payload: {} };
}

/**
 * Live Follow (client). The whole in-the-moment interaction: pick a PID, hit
 * "▶ Start recording" the moment you start the Zoom recording (the clock then
 * counts from that EXACT instant), watch the polled current step, tap preset
 * FLAGS (each = one observation pinned at the current moment), mark a QUOTE,
 * add a NOTE, and inline-create a new flag when the bar is empty. The
 * observations list is optimistic and each row is deletable (mis-taps happen).
 * (Events are auto-derived from study_events at review — no manual marking here.)
 *
 * State the parent (server) seeds: the active `pid`, the codebook id (for
 * inline-create), the participant list, the flag taxonomy, this PID's
 * existing observations, and an initial live status (current step + clock anchors
 * + the manual recording mark) so the first paint already shows everything.
 *
 * Polling: every POLL_MS we re-fetch `liveStatusForPid(pid)` (which now folds in
 * the manual recording mark) and replace the status. The clock ticks locally each
 * second off the RESOLVED start anchor (manual recording mark over task-start), so
 * it advances smoothly between polls.
 */
export default function LiveFollow({
  pid,
  codebookId,
  participants,
  flagTypes: initialFlagTypes,
  initialObservations,
  initialStatus,
}: {
  pid: string;
  codebookId: string;
  participants: LiveParticipant[];
  flagTypes: FlagType[];
  initialObservations: ObservationView[];
  initialStatus: LiveStatus;
}) {
  const router = useRouter();

  const [status, setStatus] = useState<LiveStatus>(initialStatus);
  const [observations, setObservations] = useState<ObservationView[]>(initialObservations);
  // The flag taxonomy is local state so inline-create appends without a full
  // page reload (the new flag is usable immediately).
  const [flagTypes, setFlagTypes] = useState<FlagType[]>(initialFlagTypes);
  const [note, setNote] = useState('');
  // The "armed" flag: when set, an Enter in the note box attaches this flag to
  // the note. Tapping a flag button still fires immediately (tap = flag-only).
  const [armedFlagId, setArmedFlagId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local clock tick — the current wall-clock instant (ms), re-stamped each
  // second to force a re-render so the elapsed clock AND the countdown mirror
  // advance between 3 s polls. Held in state (lazy-initialized once) rather than
  // read via `Date.now()` during render, which the react-hooks/purity rule
  // (correctly) forbids.
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Hydration guard for the time-derived clocks. `nowMs` (lazy `Date.now()`) is
  // evaluated INDEPENDENTLY during SSR and during client hydration (~1 s apart),
  // so the elapsed/task/total text mismatches (e.g. server 04:47 vs client 04:46)
  // → a hydration error. `mounted` is false on BOTH the server render and the
  // first client render (effects don't run in either), so both emit a stable
  // placeholder and agree; the effect flips it true post-mount and the live
  // values take over. Gate every time-derived clock leaf on `mounted`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Inline-create UI: whether the flag composer is open, and its draft text.
  const [newFlagOpen, setNewFlagOpen] = useState(false);
  const [newFlagLabel, setNewFlagLabel] = useState('');
  // True while a "Start recording" / reset / clear write is in flight (so the
  // button can't be double-fired).
  const [recBusy, setRecBusy] = useState(false);
  // True while a researcher→participant push broadcast is in flight (so a button
  // can't be double-fired). A small transient confirmation of the last push.
  const [pushBusy, setPushBusy] = useState(false);
  const [pushedKind, setPushedKind] = useState<PushKind | null>(null);

  const noteInputRef = useRef<HTMLInputElement>(null);

  // No prop→state sync effect: the page mounts this component with `key={pid}`,
  // so switching participants REMOUNTS it and `useState(initial…)` re-seeds
  // `status`/`observations`/taxonomies from the fresh server props.

  // 3 s poll of the live status for the active PID. No PID → no poll.
  useEffect(() => {
    if (!pid) return;
    let cancelled = false;

    async function poll() {
      try {
        const next = await liveStatusForPid(pid);
        if (!cancelled) setStatus(next);
      } catch {
        // Transient read error: keep the last good status, try again next tick.
      }
    }

    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pid]);

  // The RESOLVED clock start: the manual recording mark over the task-start. The
  // clock counts from this; observation rows are placed relative to it too.
  const clockStart = resolveClockStart(status.recordingStartedAt, status.taskStartedAt);
  const clockStartedAt = clockStart.startedAt;

  // Hard-bucket countdown mirror (T1). A DETERMINISTIC recompute off the SAME
  // phase boundaries the participant's clock uses (derived server-side from
  // study_events), via the copied `computeTimer` — not a trust-the-broadcast
  // mirror, so there is no drift from the participant's authoritative display.
  // `now` comes from the 1 s tick state (`nowMs`) so the countdown advances
  // between 3 s polls. Once the participant has FINISHED (`taskEndedAt`), freeze
  // `now` at that instant so the countdown stops with the elapsed clock. (Falls
  // back to the ticking `nowMs` if `taskEndedAt` is unparseable.)
  const now = status.taskEndedAt ? Date.parse(status.taskEndedAt) || nowMs : nowMs;
  const timer = computeTimer({
    budgets: {
      requirementsMs: REQUIREMENTS_BUDGET_MS,
      scenarioMs: SCENARIO_BUDGET_MS,
    },
    scenarioCount: status.scenarioCount,
    phaseStartsMs: status.phaseStartsMs,
    nowMs: now,
  });
  // The timer is meaningful only once a phase has actually been entered.
  const timerStarted = timer.currentPhase !== null;

  // 1 s local clock tick — only while running: it needs a start anchor and must
  // stop once the participant has finished (`taskEndedAt` set), at which point the
  // elapsed FREEZES. (A manual recording mark also drives the clock; it has no
  // "ended" event, so it ticks until the participant's `study_complete`.)
  useEffect(() => {
    if (!clockStartedAt || status.taskEndedAt) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [clockStartedAt, status.taskEndedAt]);

  // --- Recording start (the PRIMARY anchor) --------------------------------
  const onStartRecording = useCallback(async () => {
    if (!pid || recBusy) return;
    setError(null);
    setRecBusy(true);
    try {
      const { startedAt } = await markRecordingStart(pid);
      setStatus((s) => ({ ...s, recordingStartedAt: startedAt }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recording.');
    } finally {
      setRecBusy(false);
    }
  }, [pid, recBusy]);

  const onResetRecording = useCallback(async () => {
    // Re-mark = reset to NOW (the action upserts on the pid PK).
    await onStartRecording();
  }, [onStartRecording]);

  const onClearRecording = useCallback(async () => {
    if (!pid || recBusy) return;
    setError(null);
    setRecBusy(true);
    try {
      await clearRecordingStart(pid);
      setStatus((s) => ({ ...s, recordingStartedAt: null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear recording mark.');
    } finally {
      setRecBusy(false);
    }
  }, [pid, recBusy]);

  // --- Researcher → participant push (T2) -----------------------------------
  // Open a PUBLIC broadcast channel on the participant's contract channel and
  // fire one ephemeral event. Each press is its own short-lived channel: we
  // subscribe, send on SUBSCRIBED, then tear down — no long-lived socket needed
  // for a fire-and-forget trigger. This is a RESEARCHER INTERVENTION: it changes
  // the participant's screen, so firing is an uncontrolled variable (see the
  // protocol's standardized firing rule); the participant logs every receipt as
  // a study_event on their side.
  const onPush = useCallback(
    async (kind: PushKind) => {
      if (!pid || pushBusy) return;
      setError(null);
      setPushBusy(true);
      try {
        const { event, payload } = buildPushPayload(kind);
        const sb = createBrowser();
        const channel = sb.channel(participantChannel(pid), {
          config: { broadcast: { self: false } },
        });
        await new Promise<void>((resolve, reject) => {
          channel.subscribe((statusStr) => {
            if (statusStr === 'SUBSCRIBED') resolve();
            else if (
              statusStr === 'CHANNEL_ERROR' ||
              statusStr === 'TIMED_OUT' ||
              statusStr === 'CLOSED'
            )
              reject(new Error(`channel ${statusStr}`));
          });
        });
        await channel.send({ type: 'broadcast', event, payload });
        await sb.removeChannel(channel);
        setPushedKind(kind);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send push.');
      } finally {
        setPushBusy(false);
      }
    },
    [pid, pushBusy],
  );

  // --- Logging an observation (flag tap, quote, note) -----------------------

  // Optimistically prepend a row, run the insert, then reconcile (or roll back).
  const logObservation = useCallback(
    async (
      optimistic: ObservationView,
      args: {
        flagTypeId?: string | null;
        episodeId?: string | null;
        body?: string | null;
        isQuote?: boolean;
      },
      failMsg: string,
    ) => {
      setError(null);
      setObservations((prev) => [optimistic, ...prev]);
      try {
        const row = await addObservation({ pid, ...args });
        setObservations((prev) =>
          prev.map((o) =>
            o.id === optimistic.id
              ? { ...optimistic, id: row.id, createdAt: row.created_at }
              : o,
          ),
        );
      } catch (err) {
        setObservations((prev) => prev.filter((o) => o.id !== optimistic.id));
        setError(err instanceof Error ? err.message : failMsg);
      }
    },
    [pid],
  );

  // Add a flag-only observation (a tap).
  const addFlag = useCallback(
    async (flag: FlagType) => {
      const tempId = tempKey();
      await logObservation(
        {
          id: tempId,
          pid,
          flagTypeId: flag.id,
          flagLabel: flag.label,
          color: flag.color,
          episodeId: null,
          episodeName: null,
          body: null,
          isQuote: false,
          createdAt: new Date().toISOString(),
        },
        { flagTypeId: flag.id },
        'Failed to add flag.',
      );
    },
    [pid, logObservation],
  );

  // Mark a QUOTE at the current moment — a one-tap, content-free bookmark of a
  // quotable line (parallel to a flag/event tap). No flag, no event, no text: the
  // timestamp is the point — the exact words are grabbed later from the recording.
  const addQuote = useCallback(async () => {
    const tempId = tempKey();
    await logObservation(
      {
        id: tempId,
        pid,
        flagTypeId: null,
        flagLabel: null,
        color: null,
        episodeId: null,
        episodeName: null,
        body: null,
        isQuote: true,
        createdAt: new Date().toISOString(),
      },
      { isQuote: true },
      'Failed to mark quote.',
    );
  }, [pid, logObservation]);

  // Submit a note (Enter in the note box). Attaches the armed flag if one is set.
  // A blank note with no armed flag is a no-op (addObservation would reject it).
  const submitNote = useCallback(async () => {
    const body = note.trim();
    if (!body && !armedFlagId) return;

    const flag = armedFlagId ? flagTypes.find((f) => f.id === armedFlagId) ?? null : null;
    const tempId = tempKey();
    setNote('');
    setArmedFlagId(null);
    await logObservation(
      {
        id: tempId,
        pid,
        flagTypeId: flag?.id ?? null,
        flagLabel: flag?.label ?? null,
        color: flag?.color ?? null,
        episodeId: null,
        episodeName: null,
        body: body || null,
        isQuote: false,
        createdAt: new Date().toISOString(),
      },
      { flagTypeId: flag?.id ?? null, body: body || null },
      'Failed to add note.',
    );
  }, [note, armedFlagId, flagTypes, pid, logObservation]);

  const removeObservation = useCallback(async (id: string) => {
    setError(null);
    // Optimistic remove; restore on failure.
    let removed: ObservationView | undefined;
    setObservations((prev) => {
      removed = prev.find((o) => o.id === id);
      return prev.filter((o) => o.id !== id);
    });
    // A temp (optimistic-only) row that never reached the server: nothing to delete.
    if (id.startsWith('temp-')) return;
    try {
      await deleteObservation(id);
    } catch (err) {
      if (removed) {
        const r = removed;
        setObservations((prev) =>
          [r, ...prev].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        );
      }
      setError(err instanceof Error ? err.message : 'Failed to delete.');
    }
  }, []);

  // --- Inline create (so an empty bar never blocks the researcher) ----------
  const submitNewFlag = useCallback(async () => {
    const label = newFlagLabel.trim();
    if (!label) return;
    setError(null);
    try {
      const created = await createFlagType(codebookId, { label });
      setFlagTypes((prev) => [...prev, created]);
      setNewFlagLabel('');
      setNewFlagOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create flag.');
    }
  }, [newFlagLabel, codebookId]);

  // Number keys 1–9 fire the first N flags — but ONLY when no text input is
  // focused (so typing a digit into a note / composer never trips a flag).
  useEffect(() => {
    if (!pid) return;
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const flag = flagTypes[n - 1];
      if (!flag) return;
      e.preventDefault();
      void addFlag(flag);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pid, flagTypes, addFlag]);

  // Navigate to a PID (writes ?pid= so a reload resumes). router.push re-runs the
  // server page, which re-seeds props for the new participant.
  function selectPid(next: string) {
    const qs = next ? `?pid=${encodeURIComponent(next)}` : '';
    router.push(`/sessions/live${qs}`);
  }

  const recording = status.recordingStartedAt !== null;
  const elapsedLabel = formatElapsed(clockStartedAt, status.taskEndedAt);
  const finished = status.taskEndedAt !== null;
  // The participant's session date: prefer the resolved clock start, fall back to
  // the latest event. Null when neither exists (then we omit the date).
  const sessionDate = formatDate(clockStartedAt ?? status.latestAt);

  return (
    <main className="px-6 py-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Live</h1>
          <p className="text-sm text-foreground/60">
            Follow a participant in the moment. Hit{' '}
            <span className="font-medium">Start recording</span> when you start the
            Zoom recording; the clock then counts from that exact instant. Tap a
            flag (or press 1–9) to log it; add a note and press Enter.
          </p>
        </div>

        {/* Participant picker (PID → URL). */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-foreground/50">
            Participant
          </span>
          <select
            value={pid}
            onChange={(e) => selectPid(e.target.value)}
            className="min-w-48 border border-foreground/20 bg-background px-2 py-1.5 text-sm"
            aria-label="Select participant by PID"
          >
            <option value="">— pick a PID —</option>
            {participants.map((p) => (
              <option key={p.userId} value={p.pid}>
                {p.pid} · {p.firstName}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && (
        <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {!pid ? (
        <p className="text-sm text-foreground/50">
          Pick a participant to begin following.
        </p>
      ) : (
        <div className="space-y-6">
          {/* Recording-start control (the PRIMARY anchor). */}
          <section className="flex flex-wrap items-center gap-3 border border-foreground/15 px-4 py-3">
            {!recording ? (
              <button
                type="button"
                onClick={() => void onStartRecording()}
                disabled={recBusy}
                className="flex items-center gap-2 border border-foreground bg-foreground px-3 py-1.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
                title="Mark the exact moment you start the Zoom recording"
              >
                <span aria-hidden>▶</span> Start recording
              </button>
            ) : (
              <>
                <span className="flex items-center gap-2 text-sm text-foreground/80">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full bg-red-600"
                    aria-hidden
                  />
                  recording since{' '}
                  <span className="font-mono">{recordingClock(status.recordingStartedAt)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void onResetRecording()}
                  disabled={recBusy}
                  className="border border-foreground/25 px-2 py-1 text-xs text-foreground/60 transition hover:bg-foreground/5 disabled:opacity-40"
                  title="Re-mark the recording start to now (mis-clicked too early)"
                >
                  reset
                </button>
                <button
                  type="button"
                  onClick={() => void onClearRecording()}
                  disabled={recBusy}
                  className="border border-foreground/25 px-2 py-1 text-xs text-foreground/40 transition hover:bg-foreground/5 disabled:opacity-40"
                  title="Clear the manual mark (the clock falls back to task-start)"
                >
                  clear
                </button>
              </>
            )}
          </section>

          {/* Researcher → participant push (T2). Two manual triggers that change
              the participant's screen. Each fires a PUBLIC broadcast on the
              participant's contract channel; firing is a RESEARCHER INTERVENTION
              (an uncontrolled variable) — follow the protocol's firing rule. */}
          <section className="flex flex-wrap items-center gap-3 border border-foreground/15 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wider text-foreground/50">
              push
            </div>
            <button
              type="button"
              onClick={() => void onPush('show_time')}
              disabled={!pid || pushBusy}
              className="border border-foreground/25 px-3 py-1.5 text-sm transition hover:bg-foreground/5 disabled:opacity-40"
              title="Push a popup to the participant showing their overall (cumulative) time remaining"
            >
              Show time remaining
            </button>
            <button
              type="button"
              onClick={() => void onPush('offer_help')}
              disabled={!pid || pushBusy}
              className="border border-foreground/25 px-3 py-1.5 text-sm transition hover:bg-foreground/5 disabled:opacity-40"
              title="Push a popup to the participant offering to open the assistant"
            >
              Offer help
            </button>
            {pushedKind && (
              <span className="text-xs text-foreground/50">
                sent {pushedKind === 'show_time' ? 'time remaining' : 'help offer'}
              </span>
            )}
            <span className="text-[11px] text-foreground/40">
              firing is a researcher intervention — it changes the participant&apos;s
              screen
            </span>
          </section>

          {/* Current step + running clock */}
          <section className="flex flex-wrap items-center gap-6 border border-foreground/15 px-4 py-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-foreground/50">
                now
              </div>
              <div className="text-sm">
                {status.stepLabel ?? (
                  <span className="text-foreground/40">no activity yet</span>
                )}
              </div>
            </div>
            {/* Session date — identifies the participant by PID + date, never a
                name (no PII on the live surface). Omitted when we have no
                timestamp to derive it from. */}
            {sessionDate && (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-foreground/50">
                  session
                </div>
                <div className="font-mono text-sm">{sessionDate}</div>
              </div>
            )}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-foreground/50">
                {clockStart.source === 'manual' ? 'recording clock' : 'task clock'}
              </div>
              <div className="flex items-center gap-2 font-mono text-sm">
                {!mounted ? (
                  <span className="text-foreground/40">··:··</span>
                ) : (
                  elapsedLabel ?? <span className="text-foreground/40">not started</span>
                )}
                {finished && (
                  <span
                    className="text-xs text-green-700 dark:text-green-400"
                    title="Participant reached the finished screen"
                  >
                    ✓ finished
                  </span>
                )}
              </div>
            </div>

            {/* Hard-bucket countdown MIRROR (T1) — the same per-task + cumulative
                remaining the participant sees, recomputed deterministically from
                their phase boundaries. `Task` is the current phase's bucket
                (over-budget → red, leading `-`); `Total` is the floored
                cumulative across phases still ahead. Shown only once a phase has
                been entered. */}
            {timerStarted && (
              <>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-foreground/50">
                    task
                  </div>
                  <div
                    className={`font-mono text-sm ${
                      mounted && timer.taskRemainingMs < 0
                        ? 'text-red-700 dark:text-red-400'
                        : ''
                    }`}
                    title="Time remaining in the participant's CURRENT phase (hard bucket; over-budget shows negative)"
                  >
                    {!mounted
                      ? '··:··'
                      : `${timer.taskRemainingMs < 0 ? '-' : ''}${formatRemaining(timer.taskRemainingMs)}`}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-foreground/50">
                    total
                  </div>
                  <div
                    className="font-mono text-sm"
                    title="Overall (cumulative) time remaining across all phases still ahead (floored at 0; forfeits unused time at phase boundaries)"
                  >
                    {!mounted ? '··:··' : formatRemaining(timer.cumulativeRemainingMs)}
                  </div>
                </div>
              </>
            )}
          </section>

          {/* Flag bar */}
          <section>
            <div className="mb-2 text-[11px] uppercase tracking-wider text-foreground/50">
              flags
              <span className="ml-2 text-foreground/30 normal-case tracking-normal">
                (tap, or press 1–9)
              </span>
            </div>
            <div className="flex flex-wrap items-stretch gap-2">
              {flagTypes.map((ft, i) => {
                const armed = armedFlagId === ft.id;
                return (
                  <div key={ft.id} className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => void addFlag(ft)}
                      className="flex items-center gap-2 border border-foreground/25 px-3 py-1.5 text-sm transition hover:bg-foreground/5"
                      title={`Log "${ft.label}" (key ${i < 9 ? i + 1 : '—'})`}
                    >
                      {i < 9 && (
                        <span className="font-mono text-[10px] text-foreground/40">
                          {i + 1}
                        </span>
                      )}
                      <span
                        className="inline-block h-3 w-3 rounded-sm border border-foreground/20"
                        style={{ backgroundColor: ft.color ?? DEFAULT_SWATCH }}
                        aria-hidden
                      />
                      <span>{ft.label}</span>
                    </button>
                    {/* Arm-for-note toggle: attach this flag to the next note. */}
                    <button
                      type="button"
                      onClick={() => setArmedFlagId(armed ? null : ft.id)}
                      className={`border border-l-0 border-foreground/25 px-1.5 text-xs transition ${
                        armed
                          ? 'bg-foreground text-background'
                          : 'text-foreground/40 hover:bg-foreground/5'
                      }`}
                      title={armed ? 'Un-arm for note' : 'Arm this flag for the next note'}
                      aria-pressed={armed}
                      aria-label={`Arm ${ft.label} for a note`}
                    >
                      +note
                    </button>
                  </div>
                );
              })}

              {/* Inline "+ new flag" — so an empty bar never blocks the researcher. */}
              {newFlagOpen ? (
                <span className="flex items-stretch">
                  <input
                    autoFocus
                    value={newFlagLabel}
                    onChange={(e) => setNewFlagLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void submitNewFlag();
                      } else if (e.key === 'Escape') {
                        setNewFlagOpen(false);
                        setNewFlagLabel('');
                      }
                    }}
                    placeholder="new flag name"
                    aria-label="New flag name"
                    className="w-36 border border-foreground/25 bg-background px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void submitNewFlag()}
                    disabled={!newFlagLabel.trim()}
                    className="border border-l-0 border-foreground px-2 text-sm transition hover:bg-foreground hover:text-background disabled:opacity-40"
                  >
                    add
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setNewFlagOpen(true)}
                  className="border border-dashed border-foreground/30 px-3 py-1.5 text-sm text-foreground/50 transition hover:bg-foreground/5"
                  title="Create a new flag"
                >
                  + new flag
                </button>
              )}

              {/* Quote — a one-tap red-ribbon bookmark of a quotable moment. No
                  text required: the timestamp is the point; the exact words are
                  grabbed later from the recording. Parallel to a flag tap. */}
              <button
                type="button"
                onClick={() => void addQuote()}
                className="flex items-center gap-1.5 border border-red-600/50 px-3 py-1.5 text-sm text-red-700 transition hover:bg-red-600/10 dark:text-red-400"
                title="Bookmark a quotable moment at the current instant (grab the words later from the recording)"
              >
                <RedRibbon />
                <span>Quote</span>
              </button>
            </div>

            {/* Note input */}
            <div className="mt-3 flex items-center gap-2">
              <input
                ref={noteInputRef}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void submitNote();
                  }
                }}
                placeholder={
                  armedFlagId
                    ? `Note for "${flagTypes.find((f) => f.id === armedFlagId)?.label ?? ''}" — Enter to log`
                    : 'Add a note — Enter to log'
                }
                className="w-full max-w-xl border border-foreground/20 bg-background px-2 py-1.5 text-sm"
                aria-label="Observation note"
              />
              <button
                type="button"
                onClick={() => void submitNote()}
                disabled={!note.trim() && !armedFlagId}
                className="border border-foreground px-3 py-1.5 text-sm transition hover:bg-foreground hover:text-background disabled:opacity-40"
              >
                Log
              </button>
            </div>
          </section>

          {/* Observations list (reverse-chronological) */}
          <section>
            <div className="mb-2 text-[11px] uppercase tracking-wider text-foreground/50">
              observations · {observations.length}
            </div>
            {observations.length === 0 ? (
              <p className="text-sm text-foreground/50">
                No observations yet for this participant.
              </p>
            ) : (
              <ul className="divide-y divide-foreground/10 border border-foreground/15">
                {observations.map((o) => (
                  <li key={o.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-14 shrink-0 font-mono text-xs text-foreground/50">
                      {observationTime(o.createdAt, clockStartedAt)}
                    </span>
                    {o.flagLabel ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5">
                        <span
                          className="inline-block h-3 w-3 rounded-sm border border-foreground/20"
                          style={{ backgroundColor: o.color ?? DEFAULT_SWATCH }}
                          aria-hidden
                        />
                        <span className="text-foreground/80">{o.flagLabel}</span>
                      </span>
                    ) : o.episodeName ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5">
                        <span aria-hidden className="text-foreground/40">◆</span>
                        <span className="text-foreground/80">{o.episodeName}</span>
                        <span className="text-[10px] uppercase tracking-wider text-foreground/40">
                          event
                        </span>
                      </span>
                    ) : o.isQuote ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5">
                        <RedRibbon />
                        <span className="text-red-700 dark:text-red-400">quote</span>
                      </span>
                    ) : (
                      <span className="shrink-0 text-foreground/30">note</span>
                    )}
                    <span className="flex-1 text-foreground/70">{o.body}</span>
                    <button
                      type="button"
                      onClick={() => void removeObservation(o.id)}
                      className="shrink-0 px-1 text-foreground/40 transition hover:text-red-600"
                      aria-label="Delete observation"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

/** A small red ribbon glyph for the Quote marker — an inline SVG (a folded
 *  bookmark ribbon) so it renders crisply and identically across platforms,
 *  unlike an emoji whose font varies. `currentColor` lets the surrounding red
 *  text color drive it. */
function RedRibbon() {
  return (
    <svg
      width="11"
      height="14"
      viewBox="0 0 11 14"
      aria-hidden
      className="shrink-0 text-red-600"
      fill="currentColor"
    >
      {/* A ribbon/bookmark: a rectangle with a notched (swallowtail) bottom. */}
      <path d="M0 0h11v14L5.5 10 0 14V0z" />
    </svg>
  );
}

/** A unique optimistic-row id (a `temp-` row never reaches the server). */
function tempKey(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The recording-start instant as a local HH:MM:SS, for the "recording since"
 *  label. Falls back to '—' on an unparseable/absent value. */
function recordingClock(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

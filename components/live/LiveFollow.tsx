'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addObservation,
  deleteObservation,
  type ObservationView,
} from '@/app/actions/observations';
import { liveStatusForPid, type LiveStatus, type LiveParticipant } from '@/app/actions/live';
import { formatElapsed, formatDate, observationTime } from '@/lib/live/clock';
import type { Tables } from '@/lib/types/cb-db';

type FlagType = Tables<'cb_flag_types'>;

const POLL_MS = 3000;
const DEFAULT_SWATCH = '#000000';

/**
 * Live Follow (client). The whole in-the-moment interaction: pick a PID, watch
 * the polled current step + a running clock, and tap flags (1 tap = a flag-only
 * observation; Enter in the note box = a note, optionally carrying an "armed"
 * flag). The observations list is optimistic and each row is deletable
 * (mis-taps happen).
 *
 * State the parent (server) seeds: the active `pid` (from the URL), the
 * participant list, the flag taxonomy, this PID's existing observations, and an
 * initial live status so the first paint already shows the step + clock.
 *
 * Polling: every POLL_MS we re-fetch `liveStatusForPid(pid)` (a read-only study
 * query) and replace the status. The interval is cleared on unmount and
 * re-created when the pid changes. The clock ticks locally each second off the
 * `taskStartedAt` anchor, so it advances smoothly between polls.
 */
export default function LiveFollow({
  pid,
  participants,
  flagTypes,
  initialObservations,
  initialStatus,
}: {
  pid: string;
  participants: LiveParticipant[];
  flagTypes: FlagType[];
  initialObservations: ObservationView[];
  initialStatus: LiveStatus;
}) {
  const router = useRouter();

  const [status, setStatus] = useState<LiveStatus>(initialStatus);
  const [observations, setObservations] = useState<ObservationView[]>(initialObservations);
  const [note, setNote] = useState('');
  // The "armed" flag: when set, an Enter in the note box attaches this flag to
  // the note. Tapping a flag button still fires immediately (tap = flag-only).
  const [armedFlagId, setArmedFlagId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local clock tick — a counter incremented each second to force a re-render so
  // the elapsed time advances between 3 s polls.
  const [, setTick] = useState(0);

  const noteInputRef = useRef<HTMLInputElement>(null);

  // No prop→state sync effect: the page mounts this component with `key={pid}`,
  // so switching participants REMOUNTS it and `useState(initial…)` re-seeds
  // `status`/`observations` from the fresh server props. Within one PID the
  // poll updates `status` and optimistic edits update `observations`.

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

  // 1 s local clock tick — only while the task is RUNNING: it needs a start
  // anchor and must stop once the participant has finished (`taskEndedAt` set),
  // at which point the elapsed is frozen at `study_complete − taskStart` and no
  // further ticking is wanted.
  useEffect(() => {
    if (!status.taskStartedAt || status.taskEndedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status.taskStartedAt, status.taskEndedAt]);

  // Add a flag-only observation (a tap). Optimistic: prepend a temp row, then
  // reconcile with the server row (or roll back on failure).
  const addFlag = useCallback(
    async (flag: FlagType) => {
      setError(null);
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const optimistic: ObservationView = {
        id: tempId,
        pid,
        flagTypeId: flag.id,
        flagLabel: flag.label,
        color: flag.color,
        body: null,
        createdAt: new Date().toISOString(),
      };
      setObservations((prev) => [optimistic, ...prev]);
      try {
        const row = await addObservation({ pid, flagTypeId: flag.id });
        setObservations((prev) =>
          prev.map((o) =>
            o.id === tempId
              ? { ...optimistic, id: row.id, createdAt: row.created_at }
              : o,
          ),
        );
      } catch (err) {
        setObservations((prev) => prev.filter((o) => o.id !== tempId));
        setError(err instanceof Error ? err.message : 'Failed to add flag.');
      }
    },
    [pid],
  );

  // Submit a note (Enter in the note box). Attaches the armed flag if one is set.
  // A blank note with no armed flag is a no-op (addObservation would reject it).
  const submitNote = useCallback(async () => {
    const body = note.trim();
    if (!body && !armedFlagId) return;
    setError(null);

    const flag = armedFlagId ? flagTypes.find((f) => f.id === armedFlagId) ?? null : null;
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: ObservationView = {
      id: tempId,
      pid,
      flagTypeId: flag?.id ?? null,
      flagLabel: flag?.label ?? null,
      color: flag?.color ?? null,
      body: body || null,
      createdAt: new Date().toISOString(),
    };
    setObservations((prev) => [optimistic, ...prev]);
    setNote('');
    setArmedFlagId(null);
    try {
      const row = await addObservation({
        pid,
        flagTypeId: flag?.id ?? null,
        body: body || null,
      });
      setObservations((prev) =>
        prev.map((o) =>
          o.id === tempId ? { ...optimistic, id: row.id, createdAt: row.created_at } : o,
        ),
      );
    } catch (err) {
      setObservations((prev) => prev.filter((o) => o.id !== tempId));
      setError(err instanceof Error ? err.message : 'Failed to add note.');
    }
  }, [note, armedFlagId, flagTypes, pid]);

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

  // Number keys 1–9 fire the first N flags — but ONLY when the note input is not
  // focused (so typing a digit into a note never trips a flag).
  useEffect(() => {
    if (!pid) return;
    function onKey(e: KeyboardEvent) {
      if (document.activeElement === noteInputRef.current) return;
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

  const elapsedLabel = formatElapsed(status.taskStartedAt, status.taskEndedAt);
  const finished = status.taskEndedAt !== null;
  // The participant's session date: prefer the task-start anchor, fall back to
  // the latest event. Null when neither exists (then we omit the date).
  const sessionDate = formatDate(status.taskStartedAt ?? status.latestAt);

  return (
    <main className="px-6 py-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Live</h1>
          <p className="text-sm text-foreground/60">
            Follow a participant in the moment: their current step polls every 3 s
            and the clock previews where a flag lands in the recording. Tap a flag
            (or press 1–9) to log it; add a note and press Enter.
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
                task clock
              </div>
              <div className="flex items-center gap-2 font-mono text-sm">
                {elapsedLabel ?? (
                  <span className="text-foreground/40">task not started</span>
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
          </section>

          {/* Flag bar */}
          <section>
            <div className="mb-2 text-[11px] uppercase tracking-wider text-foreground/50">
              flags
              <span className="ml-2 text-foreground/30 normal-case tracking-normal">
                (tap, or press 1–9)
              </span>
            </div>
            {flagTypes.length === 0 ? (
              <p className="text-sm text-foreground/50">
                No flags defined yet. Add some on the{' '}
                <a href="/flag-types" className="underline underline-offset-2">
                  Flags
                </a>{' '}
                page.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
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
              </div>
            )}

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
                      {observationTime(o.createdAt, status.taskStartedAt)}
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

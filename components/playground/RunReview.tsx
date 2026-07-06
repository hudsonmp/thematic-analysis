'use client';

import { useMemo, useState, useTransition } from 'react';
import { getParticipantProgression } from '@/app/actions/progression';
import type {
  ParticipantProgression,
  ProgressionParticipant,
} from '@/app/actions/progression';
import type { RunSummary } from '@/app/actions/runs';
import { groupByCohort, cohortKey } from '@/lib/eval/playground/selection';
import RunReviewStepper from '@/components/playground/RunReviewStepper';

// ---------------------------------------------------------------------------
// Run-review island (Task C-2: browse + spec-evolution stepper).
//
// LEFT rail:
//   (1) A RUN PICKER — a <select> over listRuns()'s summaries, defaulting to
//       "— no run (browse specs) —". The chosen run id is held in state
//       (selectedRunId) and threaded to the stepper, but NO verdict overlay is
//       wired yet — the screen is fully browsable with NO run selected. Task
//       C-3 consumes selectedRunId to call listVerdicts + overlay per-cell.
//   (2) A PARTICIPANT PICKER grouped by cohort (via the shared groupByCohort /
//       null-last comparator from lib/eval/playground/selection — NOT
//       reimplemented here), each row a pid + n/5 stepCount hint. Mirrors
//       ProgressionViewer's picker idiom exactly.
//
// Selecting a participant calls the getParticipantProgression SERVER ACTION
// from the click HANDLER via useTransition (never at render) and holds the
// result in state — the standard island pattern.
//
// RIGHT: <RunReviewStepper/> once a participant is loaded, else an empty hint.
// ---------------------------------------------------------------------------

export default function RunReview({
  participants,
  runs,
}: {
  participants: ProgressionParticipant[];
  runs: RunSummary[];
}) {
  // Held for Task C-3 (verdict overlay): selecting a run there will call
  // listVerdicts(selectedRunId). No overlay is wired in this task.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activePid, setActivePid] = useState<string | null>(null);
  const [progression, setProgression] = useState<ParticipantProgression | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Cohort groups via the shared null-last helper (pilot, study, …, then "—"
  // for snapshot-only PIDs with no session). byPid resolves each pid back to
  // its full participant row for the n/5 stepCount hint.
  const groups = useMemo(() => groupByCohort(participants), [participants]);
  const byPid = useMemo(() => {
    const m = new Map<string, ProgressionParticipant>();
    for (const p of participants) m.set(p.pid, p);
    return m;
  }, [participants]);

  function pick(pid: string) {
    setActivePid(pid);
    setError(null);
    startTransition(async () => {
      try {
        const result = await getParticipantProgression(pid);
        setProgression(result);
      } catch (err) {
        setProgression(null);
        setError(err instanceof Error ? err.message : 'Failed to load progression.');
      }
    });
  }

  return (
    <div className="flex gap-6">
      {/* ---- Left rail: run picker + participant picker ---- */}
      <aside className="w-56 shrink-0 space-y-5">
        {/* (1) Run picker — held for C-3's verdict overlay. No overlay yet. */}
        <section>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground/50">
            Run
          </h2>
          <select
            value={selectedRunId ?? ''}
            onChange={(e) => setSelectedRunId(e.target.value === '' ? null : e.target.value)}
            className="w-full border border-foreground/15 bg-[var(--background)] px-2 py-1.5 text-sm"
            aria-label="Select a run to review (optional)"
          >
            <option value="">— no run (browse specs) —</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.status} · {r.verdictCount}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] leading-snug text-foreground/40">
            Optional — pick a run to review its grades (coming next). Browse specs
            with no run selected.
          </p>
        </section>

        {/* (2) Participant picker — grouped by cohort (null-last), n/5 hint. */}
        {participants.length === 0 && (
          <p className="text-sm text-foreground/60">No participants with snapshots.</p>
        )}
        {groups.map(({ cohort, pids }) => (
          <section key={cohortKey(cohort)}>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground/50">
              {cohort ?? '—'} · {pids.length}
            </h2>
            <ul className="divide-y divide-foreground/10 border border-foreground/15">
              {pids.map((pid) => {
                const p = byPid.get(pid);
                return (
                  <li key={pid}>
                    <button
                      type="button"
                      onClick={() => pick(pid)}
                      disabled={isPending}
                      aria-pressed={activePid === pid}
                      className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-sm transition disabled:opacity-50 ${
                        activePid === pid ? 'bg-foreground text-background' : 'hover:bg-foreground/5'
                      }`}
                    >
                      <span className="font-mono">{pid}</span>
                      <span
                        className={
                          activePid === pid
                            ? 'text-background/70 text-xs'
                            : 'text-foreground/40 text-xs'
                        }
                      >
                        {p?.stepCount ?? 0}/5
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </aside>

      {/* ---- Right: spec-evolution stepper ---- */}
      <div className="min-w-0 flex-1">
        {error && (
          <p className="mb-3 border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {!activePid && (
          <p className="text-sm text-foreground/60">
            Pick a participant to walk their specification across the five phases.
          </p>
        )}
        {activePid && isPending && <p className="text-sm text-foreground/40">Loading {activePid}…</p>}
        {activePid && !isPending && !progression && !error && (
          <p className="text-sm text-foreground/60">No progression data for {activePid}.</p>
        )}

        {progression && !isPending && <RunReviewStepper progression={progression} />}
      </div>
    </div>
  );
}

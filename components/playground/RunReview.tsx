'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { getParticipantProgression } from '@/app/actions/progression';
import type {
  ParticipantProgression,
  ProgressionParticipant,
} from '@/app/actions/progression';
import { listVerdicts, type RunSummary, type VerdictRow } from '@/app/actions/runs';
import type { PromptVariant } from '@/app/actions/eval';
import { groupByCohort, cohortKey } from '@/lib/eval/playground/selection';
import RunReviewStepper from '@/components/playground/RunReviewStepper';
import AnnotatePanel, { AnnotateContext } from '@/components/playground/AnnotatePanel';

// ---------------------------------------------------------------------------
// Run-review island (Task C-2 browse + C-3 verdict overlay + per-cell fold).
//
// LEFT rail:
//   (1) A RUN PICKER — a <select> over listRuns()'s summaries, defaulting to
//       "— no run (browse specs) —". The chosen run id (selectedRunId) drives
//       listVerdicts(runId) (C-3), indexed below into verdictsByCell keyed
//       `${pid}|${phaseOrdinal}|${scenarioIdx}` and threaded to the stepper for
//       the per-(phase × scenario) verdict overlay. With NO run selected the
//       screen is fully browsable — every cell renders "—" (honest absent), not
//       a fabricated fail.
//   (2) A PARTICIPANT PICKER grouped by cohort (via the shared groupByCohort /
//       null-last comparator from lib/eval/playground/selection — NOT
//       reimplemented here), each row a pid + n/5 stepCount hint. Mirrors
//       ProgressionViewer's picker idiom exactly.
//
// Selecting a participant calls getParticipantProgression from the click
// HANDLER via useTransition (never at render); selecting a run loads its
// verdicts in an effect-driven transition (setState lives INSIDE the transition
// callback, mirroring AnnotatePanel/Playground's set-state-in-effect discipline).
//
// FOLD LOOP (C-3, mirrors Playground): per-cell annotate boxes in the stepper
// call saveAnnotation with the (pid, phaseOrdinal, scenarioIdx) coordinate (+
// optional run/verdict link) and then fire AnnotateContext.onSaved. This island
// is the AnnotateContext.Provider: onSaved bumps a monotonic annotationRefresh
// token threaded to the mounted <AnnotatePanel/>, which re-pulls the unfolded
// list and folds the checked notes into a NEW child variant — the SAME loop as
// /llm, now closed on /llm/run.
//
// RIGHT: <RunReviewStepper/> once a participant is loaded, else an empty hint;
// the fold panel sits below, always mounted so the review→annotate→fold loop
// closes even before a participant is picked.
// ---------------------------------------------------------------------------

export default function RunReview({
  participants,
  runs,
  promptVariants,
}: {
  participants: ProgressionParticipant[];
  runs: RunSummary[];
  promptVariants: PromptVariant[];
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activePid, setActivePid] = useState<string | null>(null);
  const [progression, setProgression] = useState<ParticipantProgression | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Selected run's verdicts, loaded on selectedRunId change. Null while no run
  // is selected (browse mode) — distinct from an empty array (a loaded run that
  // graded nothing); either way each cell renders "—" (never a fake fail).
  const [verdicts, setVerdicts] = useState<VerdictRow[] | null>(null);
  const [verdictError, setVerdictError] = useState<string | null>(null);
  const [isLoadingVerdicts, startLoadingVerdicts] = useTransition();

  // Variant lineage lifted to state so a fold adds a selectable variant (mirrors
  // Playground). Seeded from the server prop; a fold prepends the new child.
  const [variants, setVariants] = useState<PromptVariant[]>(promptVariants);
  // Monotonic token: bumped on every per-cell note-save so AnnotatePanel
  // re-pulls its unfolded-annotation list (the fold panel's checkbox source).
  const [annotationRefresh, setAnnotationRefresh] = useState(0);

  // Cohort groups via the shared null-last helper (pilot, study, …, then "—"
  // for snapshot-only PIDs with no session). byPid resolves each pid back to
  // its full participant row for the n/5 stepCount hint.
  const groups = useMemo(() => groupByCohort(participants), [participants]);
  const byPid = useMemo(() => {
    const m = new Map<string, ProgressionParticipant>();
    for (const p of participants) m.set(p.pid, p);
    return m;
  }, [participants]);

  // Index the selected run's verdicts by (pid, phaseOrdinal, scenarioIdx) so the
  // stepper does an O(1) cell lookup. scenarioIdx is nullable in the row; a
  // null-idx verdict keys with 'x' and simply won't be matched by a 0..3 cell
  // (the stepper only looks up integer scenario indices) — honest absence.
  const verdictsByCell = useMemo(() => {
    const m = new Map<string, VerdictRow>();
    for (const v of verdicts ?? []) {
      m.set(`${v.pid}|${v.phaseOrdinal}|${v.scenarioIdx ?? 'x'}`, v);
    }
    return m;
  }, [verdicts]);

  // Load verdicts when the selected run changes. ALL setState lives INSIDE the
  // transition callback (never bare in the effect body) to dodge the
  // set-state-in-effect lint, matching AnnotatePanel's load idiom — including
  // the browse-mode branch (selectedRunId null → clear to null, honest absence).
  useEffect(() => {
    const runId = selectedRunId;
    startLoadingVerdicts(async () => {
      if (runId === null) {
        setVerdicts(null);
        setVerdictError(null);
        return;
      }
      try {
        const rows = await listVerdicts(runId);
        setVerdicts(rows);
        setVerdictError(null);
      } catch (err) {
        setVerdicts(null);
        setVerdictError(err instanceof Error ? err.message : 'Failed to load verdicts.');
      }
    });
    // startLoadingVerdicts is a stable useTransition dispatcher; selectedRunId
    // is the trigger.
  }, [selectedRunId]);

  function onSaved() {
    setAnnotationRefresh((n) => n + 1);
  }

  function onFolded(variant: PromptVariant) {
    setVariants((prev) => [variant, ...prev]);
  }

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
    <AnnotateContext.Provider value={{ onSaved }}>
    <div className="flex gap-6">
      {/* ---- Left rail: run picker + participant picker ---- */}
      <aside className="w-56 shrink-0 space-y-5">
        {/* (1) Run picker — drives the per-cell verdict overlay (C-3). */}
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
            Optional — pick a run to overlay its grades on each cell. Browse specs
            with no run selected (cells read &ldquo;—&rdquo;).
          </p>
          {isLoadingVerdicts && (
            <p className="mt-1 text-[11px] text-foreground/40">Loading verdicts…</p>
          )}
          {verdictError && (
            <p className="mt-1 text-[11px] leading-snug text-red-700">{verdictError}</p>
          )}
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

      {/* ---- Right: spec-evolution stepper + fold panel ---- */}
      <div className="min-w-0 flex-1 space-y-6">
        <div>
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
          {activePid && isPending && (
            <p className="text-sm text-foreground/40">Loading {activePid}…</p>
          )}
          {activePid && !isPending && !progression && !error && (
            <p className="text-sm text-foreground/60">No progression data for {activePid}.</p>
          )}

          {progression && !isPending && (
            <RunReviewStepper
              progression={progression}
              verdictsByCell={verdictsByCell}
              selectedRunId={selectedRunId}
            />
          )}
        </div>

        {/* Fold panel — always mounted so review→annotate→fold closes on
            /llm/run exactly as on /llm. A per-cell save bumps annotationRefresh,
            the panel re-pulls its unfolded list, and a fold prepends a new
            variant to `variants`. */}
        <AnnotatePanel
          refreshToken={annotationRefresh}
          variants={variants}
          onFolded={onFolded}
        />
      </div>
    </div>
    </AnnotateContext.Provider>
  );
}

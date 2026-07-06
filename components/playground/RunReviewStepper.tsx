'use client';

import { useContext, useState, useTransition } from 'react';
import type { ParticipantProgression } from '@/app/actions/progression';
import type { VerdictRow } from '@/app/actions/runs';
import { saveAnnotation } from '@/app/actions/eval';
import { RequirementsPane, ScenarioPane } from '@/components/progression/AuthoredScenarioPane';
import { AnnotateContext } from '@/components/playground/AnnotatePanel';

// ---------------------------------------------------------------------------
// Run-review stepper (Task C-2 spec evolution + C-3 verdict overlay / annotate).
//
// Mirrors ProgressionViewer's stepper, but TEXT-ONLY per Hudson: the left pane
// shows ONLY the participant's specification TEXT at the active phase — no
// entity grid, no diff, no map. The right pane shows the authored content the
// participant was responding to, REUSING A's RequirementsPane (Requirement
// step, ordinal 0) / ScenarioPane (Scenario steps, indexed by scenarioIdx).
//
// The 5 steps are Requirement (ordinal 0) + Scenario 1–4 (ordinals 1–4). Data
// scenario_idx is 0-based; DISPLAY is 1-based — the labels come pre-built on
// each ProgressionStep (label already reads "Scenario 1" etc.), matching
// ProgressionViewer. `final` is NOT a step (it is a byte-identical re-flush of
// the last scenario); the engine surfaces it as `submitted` on the last
// scenario, rendered here as a ✓ badge.
//
// C-3 VERDICT OVERLAY + PER-CELL ANNOTATE:
//   For the ACTIVE phase (activeStep.ordinal) a 4-scenario cell strip renders
//   scenarioIdx 0..3 (DISPLAY 1..4). Each cell looks up
//   verdictsByCell.get(`${pid}|${ordinal}|${scenarioIdx}`):
//     • no run selected / run didn't grade this cell → verdict is undefined →
//       "—" (honest absent), NEVER a fabricated fail;
//     • present → pass ✓/✗ (null pass → —) and score (null score → —, a real 0
//       shows "0.00" — the grid's null≠0 honest-signal rule).
//   Each cell carries a per-cell annotate box (textarea + Save) that calls
//   saveAnnotation with the (pid, phaseOrdinal, scenarioIdx) COORDINATE always,
//   plus runId/verdictId ONLY when a run graded the cell (the verdict link is
//   optional — a note binds to the cell coordinate, browsable standalone). On
//   success it fires AnnotateContext.onSaved so the mounted fold panel refreshes.
//
// Land the active tab on the first phase that has a snapshot (always 0 in
// practice; defensive for a truncated tail). Tabs with no snapshot are
// disabled — you cannot review a phase with no spec state.
// ---------------------------------------------------------------------------

/** The four scenario columns overlaid at each phase (0-based data, 1-based UI). */
const SCENARIO_IDXS = [0, 1, 2, 3] as const;

export default function RunReviewStepper({
  progression,
  verdictsByCell,
  selectedRunId,
}: {
  progression: ParticipantProgression;
  /** (pid, phaseOrdinal, scenarioIdx) → verdict for the selected run; empty when
   *  no run is selected. Keyed `${pid}|${phaseOrdinal}|${scenarioIdx}`. */
  verdictsByCell: Map<string, VerdictRow>;
  /** The run whose verdicts are overlaid, or null (browse mode). Linked onto a
   *  per-cell annotation when present. */
  selectedRunId: string | null;
}) {
  const [activeOrdinal, setActiveOrdinal] = useState<number>(
    () => progression.steps.find((s) => s.snapshot)?.ordinal ?? 0,
  );

  const activeStep = progression.steps.find((s) => s.ordinal === activeOrdinal) ?? null;

  return (
    <>
      {/* Step tabs. Disabled when that phase has no snapshot (truncated tail). */}
      <div className="mb-4 flex items-center gap-1 border-b border-foreground/15">
        {progression.steps.map((step) => (
          <button
            key={step.ordinal}
            type="button"
            onClick={() => setActiveOrdinal(step.ordinal)}
            disabled={!step.snapshot}
            className={`px-3 py-1.5 text-sm transition disabled:opacity-30 ${
              activeOrdinal === step.ordinal
                ? 'border-b-2 border-foreground font-medium'
                : 'text-foreground/60 hover:text-foreground'
            }`}
          >
            {step.label}
            {step.submitted && (
              <span
                className="ml-1 text-emerald-700"
                title="final submission recorded (identical to the last flushed scenario)"
                aria-label="final submission recorded"
              >
                ✓
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto pb-1 text-xs text-foreground/40">
          {progression.pid} · {progression.title}
        </span>
      </div>

      {activeStep && activeStep.snapshot && (
        <div className="grid grid-cols-2 gap-6">
          {/* LEFT: participant's SPEC at this phase — TEXT ONLY (no entities). */}
          <section className="min-w-0 space-y-2">
            <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Specification · {progression.pid} · {activeStep.label}
            </h3>
            <div className="border border-[var(--rule)] bg-[var(--rule-soft)] p-3">
              {activeStep.snapshot.spec ? (
                <p className="text-[15px] leading-relaxed font-mono whitespace-pre-wrap break-words">
                  {activeStep.snapshot.spec}
                </p>
              ) : (
                <p className="text-xs italic text-[var(--muted)]">(no spec at this phase)</p>
              )}
            </div>
          </section>

          {/* RIGHT: what they were responding to — A's authored panes. */}
          <section className="min-w-0 space-y-2">
            <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
              {activeStep.kind === 'requirement'
                ? 'Authored requirements'
                : `Authored · ${activeStep.label}`}
            </h3>
            {activeStep.kind === 'requirement' ? (
              <RequirementsPane requirements={progression.requirements} />
            ) : (
              <ScenarioPane
                scenario={
                  activeStep.scenarioIdx !== null
                    ? progression.scenarios[activeStep.scenarioIdx] ?? null
                    : null
                }
              />
            )}
          </section>

          {/* Verdict overlay + per-cell annotate strip — spans both columns so
              the four scenario cells read as one row under the panes. */}
          <div className="col-span-2 space-y-2">
            <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Verdicts · {activeStep.label}
              {!selectedRunId && (
                <span className="ml-2 normal-case tracking-normal text-[var(--muted)]">
                  (no run selected — grades show &ldquo;—&rdquo;)
                </span>
              )}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {SCENARIO_IDXS.map((scenarioIdx) => (
                <VerdictCell
                  key={scenarioIdx}
                  pid={progression.pid}
                  phaseOrdinal={activeStep.ordinal}
                  scenarioIdx={scenarioIdx}
                  verdict={
                    verdictsByCell.get(
                      `${progression.pid}|${activeStep.ordinal}|${scenarioIdx}`,
                    ) ?? null
                  }
                  selectedRunId={selectedRunId}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * One (phase × scenario) cell: verdict overlay + per-cell annotate box.
 *
 * OVERLAY (null≠0, mirroring VerdictGrid's honest-signal rule): `verdict` is
 * null when no run graded this cell → "—", never a fabricated fail. A present
 * verdict shows pass ✓/✗ (null pass → —) and score with two decimals (null
 * score → —; a real 0 renders "0.00").
 *
 * ANNOTATE: the (pid, phaseOrdinal, scenarioIdx) COORDINATE is ALWAYS sent so a
 * note binds to the cell even with no run/verdict (browsable standalone).
 * runId/verdictId ride along ONLY when a run graded this cell — the verdict link
 * is optional. On save, AnnotateContext.onSaved refreshes the mounted fold panel.
 */
function VerdictCell({
  pid,
  phaseOrdinal,
  scenarioIdx,
  verdict,
  selectedRunId,
}: {
  pid: string;
  phaseOrdinal: number;
  scenarioIdx: number;
  verdict: VerdictRow | null;
  selectedRunId: string | null;
}) {
  const { onSaved } = useContext(AnnotateContext);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [isSaving, startSaving] = useTransition();

  function save() {
    const trimmed = note.trim();
    if (!trimmed) {
      setError('Write a note before saving.');
      return;
    }
    setError(null);
    startSaving(async () => {
      try {
        // Coordinates ALWAYS; run/verdict link only when this cell was graded.
        await saveAnnotation({
          pid,
          phaseOrdinal,
          scenarioIdx,
          runId: selectedRunId ?? undefined,
          verdictId: verdict?.id ?? undefined,
          note: trimmed,
        });
        setNote('');
        setJustSaved(true);
        onSaved(); // → RunReview bumps the refresh token → fold panel re-pulls.
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save annotation.');
      }
    });
  }

  // null pass → —, else ✓/✗; null score → —, else two decimals (real 0 = 0.00).
  const passLabel = !verdict || verdict.pass === null ? '—' : verdict.pass ? '✓' : '✗';
  const scoreLabel =
    !verdict || verdict.score === null ? '—' : verdict.score.toFixed(2);
  const passClass =
    !verdict || verdict.pass === null
      ? 'text-foreground/40'
      : verdict.pass
        ? 'text-emerald-700'
        : 'text-red-700';

  return (
    <div className="space-y-2 border border-[var(--rule)] bg-[var(--rule-soft)] p-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-foreground/70">
          Scenario {scenarioIdx + 1}
        </span>
        <span className="font-mono text-xs">
          <span className={passClass}>{passLabel}</span>
          <span className="ml-1 text-foreground/50">{scoreLabel}</span>
        </span>
      </div>
      {verdict?.rationale && (
        <p className="line-clamp-3 text-[11px] leading-snug text-foreground/50" title={verdict.rationale}>
          {verdict.rationale}
        </p>
      )}
      <textarea
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setJustSaved(false);
        }}
        placeholder="note on this cell…"
        aria-label={`Annotate scenario ${scenarioIdx + 1} at phase ${phaseOrdinal}`}
        spellCheck={false}
        className="min-h-[3rem] w-full resize-y border border-rule bg-background px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-foreground/40"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={isSaving}
          className="border border-foreground/20 px-2 py-0.5 text-xs transition hover:bg-foreground/5 disabled:opacity-50"
        >
          {isSaving ? 'saving…' : 'Save'}
        </button>
        {justSaved && !isSaving && (
          <span className="text-[11px] text-foreground/50">saved · fold below</span>
        )}
      </div>
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

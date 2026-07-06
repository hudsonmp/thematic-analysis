'use client';

import { useState } from 'react';
import type { ParticipantProgression } from '@/app/actions/progression';
import { RequirementsPane, ScenarioPane } from '@/components/progression/AuthoredScenarioPane';

// ---------------------------------------------------------------------------
// Run-review stepper (Task C-2: spec-evolution over the five phases).
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
// Land the active tab on the first phase that has a snapshot (always 0 in
// practice; defensive for a truncated tail). Tabs with no snapshot are
// disabled — you cannot review a phase with no spec state.
//
// >>> TASK C-3 SEAM <<<
// C-3 mounts, per (phase × scenario) cell, the verdict overlay (pass ✓/✗/—,
// score; null distinct from a real 0) + a per-cell annotate box that calls
// saveAnnotation({ pid, phaseOrdinal, scenarioIdx, runId?, verdictId?, note }).
// The seam is marked inline below (search "C-3 SEAM"): C-3 will (a) accept a
// `verdictsByCell` prop indexed on (pid, phaseOrdinal, scenarioIdx) and the
// selectedRunId, and (b) render a 4-scenario cell strip under the right pane.
// Nothing verdict/annotation-related is wired in THIS task.
// ---------------------------------------------------------------------------

export default function RunReviewStepper({
  progression,
}: {
  progression: ParticipantProgression;
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

            {/*
              >>> C-3 SEAM <<<
              Mount the per-(phase × scenario) verdict overlay + annotate here.
              For the active phase (activeStep.ordinal) render a strip of the 4
              authored scenarios; each cell shows its verdict from the selected
              run (pass ✓/✗/—, score — null ≠ a real 0) and an annotate box that
              saves saveAnnotation({ pid: progression.pid, phaseOrdinal:
              activeStep.ordinal, scenarioIdx, runId?, verdictId?, note }).
              Requires the verdict index + selectedRunId threaded from RunReview.
            */}
          </section>
        </div>
      )}
    </>
  );
}

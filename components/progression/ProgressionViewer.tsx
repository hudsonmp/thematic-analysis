'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { getParticipantProgression } from '@/app/actions/progression';
import type {
  ParticipantProgression,
  ProgressionParticipant,
} from '@/app/actions/progression';
import ProgressionEntityGrid from '@/components/progression/ProgressionEntityGrid';
import { RequirementsPane, ScenarioPane } from '@/components/progression/AuthoredScenarioPane';

// ---------------------------------------------------------------------------
// Progression viewer island. LEFT: participant picker mirroring the /sessions
// index — grouped by cohort (pilot / study / "—" for snapshot-only PIDs with no
// session), one clickable row per pid with an n/5 filled-steps hint. RIGHT: the
// 5-step phase stepper (Requirement, Scenarios 1–4; data scenario_idx is
// 0-based, display is 1-based) over two panes — the participant's spec+entities
// at that phase (with the entity diff overlaid) and the authored content they
// were responding to. `final` is not a step: it renders as a "submitted ✓"
// badge on Scenario 4 (it is byte-identical to it for every participant).
// Server action called from a HANDLER (never render), result held in state —
// the standard island pattern (SessionsIndex / LiveFollow).
// ---------------------------------------------------------------------------

export default function ProgressionViewer({
  participants,
}: {
  participants: ProgressionParticipant[];
}) {
  const [activePid, setActivePid] = useState<string | null>(null);
  const [progression, setProgression] = useState<ParticipantProgression | null>(null);
  const [activeOrdinal, setActiveOrdinal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function pick(pid: string) {
    setActivePid(pid);
    setError(null);
    startTransition(async () => {
      try {
        const result = await getParticipantProgression(pid);
        setProgression(result);
        // Land on the first step that has data (always 0 in practice — nobody
        // is missing `initial` — but stay defensive).
        setActiveOrdinal(result?.steps.find((s) => s.snapshot)?.ordinal ?? 0);
      } catch (err) {
        setProgression(null);
        setError(err instanceof Error ? err.message : 'Failed to load progression.');
      }
    });
  }

  // Cohort grouping, sorted: pilot, study, then "—" (no session) via '~' sentinel.
  const groups = new Map<string, ProgressionParticipant[]>();
  for (const p of [...participants].sort(
    (a, b) => (a.cohort ?? '~').localeCompare(b.cohort ?? '~') || a.pid.localeCompare(b.pid),
  )) {
    const key = p.cohort ?? '—';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const activeStep = progression?.steps.find((s) => s.ordinal === activeOrdinal) ?? null;
  const activeParticipant = participants.find((p) => p.pid === activePid) ?? null;

  return (
    <div className="flex gap-6">
      {/* ---- Left rail: participant picker (mirrors SessionsIndex grouping) ---- */}
      <aside className="w-56 shrink-0 space-y-5">
        {participants.length === 0 && (
          <p className="text-sm text-foreground/60">No participants with snapshots.</p>
        )}
        {[...groups.entries()].map(([cohort, group]) => (
          <section key={cohort}>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground/50">
              {cohort} · {group.length}
            </h2>
            <ul className="divide-y divide-foreground/10 border border-foreground/15">
              {group.map((p) => (
                <li key={p.pid}>
                  <button
                    type="button"
                    onClick={() => pick(p.pid)}
                    disabled={isPending}
                    aria-pressed={activePid === p.pid}
                    className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-sm transition disabled:opacity-50 ${
                      activePid === p.pid ? 'bg-foreground text-background' : 'hover:bg-foreground/5'
                    }`}
                  >
                    <span className="font-mono">{p.pid}</span>
                    <span className={activePid === p.pid ? 'text-background/70 text-xs' : 'text-foreground/40 text-xs'}>
                      {p.stepCount}/5
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>

      {/* ---- Right: stepper + panes ---- */}
      <div className="min-w-0 flex-1">
        {error && (
          <p className="mb-3 border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">{error}</p>
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

        {progression && !isPending && (
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
                  {/* Submitted badge. NOTE: for 2 real participants a `final`
                      flush exists WITHOUT a Scenario-4 snapshot (the engine
                      reports submitted=true, snapshot=null) — the ✓ then sits
                      on a disabled tab, truthfully: they submitted, but there
                      is no Scenario-4 state to view. Copy stays generic for
                      exactly that reason (final ≡ last FLUSHED scenario). */}
                  {step.submitted && (
                    <span
                      className="ml-1 text-emerald-700"
                      title="final submission recorded (identical to the last flushed scenario)"
                    >
                      ✓
                    </span>
                  )}
                </button>
              ))}
              <span className="ml-auto pb-1 text-xs text-foreground/40">
                {progression.title}
                {activeParticipant?.sessionId ? (
                  <>
                    {' · '}
                    <Link
                      href={`/sessions/${activeParticipant.sessionId}`}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      open session →
                    </Link>
                  </>
                ) : null}
              </span>
            </div>

            {activeStep && activeStep.snapshot && (
              <div className="grid grid-cols-2 gap-6">
                {/* Participant state at this phase */}
                <section className="min-w-0 space-y-2">
                  <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
                    Participant · {activePid} · {activeStep.label}
                  </h3>
                  <div className="border border-[var(--rule)] bg-[var(--rule-soft)] p-3 flex flex-col gap-2">
                    <h4 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
                      Entities &amp; Elements
                    </h4>
                    <ProgressionEntityGrid
                      entities={activeStep.snapshot.entities}
                      diff={activeStep.diff}
                    />
                    <p
                      className="font-mono text-[10px] tracking-tighter text-[var(--muted)] select-none leading-none my-2"
                      aria-hidden
                    >
                      ================================================
                    </p>
                    {activeStep.snapshot.spec ? (
                      <p className="text-[15px] leading-relaxed font-mono whitespace-pre-wrap break-words">
                        {activeStep.snapshot.spec}
                      </p>
                    ) : (
                      <p className="text-xs italic text-[var(--muted)]">(empty specification at this phase)</p>
                    )}
                  </div>
                </section>

                {/* What they were responding to */}
                <section className="min-w-0 space-y-2">
                  <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
                    {activeStep.kind === 'requirement' ? 'Authored requirements' : `Authored · ${activeStep.label}`}
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
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

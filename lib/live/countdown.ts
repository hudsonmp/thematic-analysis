// ---------------------------------------------------------------------------
// `/live` timer MIRROR — HARD PER-PHASE BUCKETS, NO CARRYOVER (pure; no
// React/DOM, so it can be unit-reasoned independently of the component).
//
// This is a VERBATIM port of the participant timer model in spec-study-app's
// `lib/study/timer.ts`. The two repos cannot import each other, so the only
// thing keeping the researcher's `/live` countdown identical to what the
// participant sees is (a) this copied model and (b) the SHARED FIXTURE SET
// (`__fixtures__/timer-cases.ts`, copied verbatim from spec-study-app). Both
// repos compute the timer from the SAME `study_events`; treat the formulas and
// fixtures as a frozen cross-repo contract — changing one means re-deriving
// BOTH repos. Design: docs/superpowers/specs/2026-06-18-live-timer-and-push-
// design.md.
//
// The participant display is authoritative; `/live` is a deterministic
// recompute off the same events (`computeTimer` fed by phase boundaries derived
// from `study_events` server-side — see app/actions/live.ts), NOT a
// trust-the-broadcast mirror, so there is no drift.
//
// ---------------------------------------------------------------------------
// MODEL
//
// Phases, in order, for a `task` module:
//   REQUIREMENTS (budget REQUIREMENTS_BUDGET_MS) = intro + initial_spec
//   SCENARIO idx (budget SCENARIO_BUDGET_MS)     = scenario_read → [ponder] →
//                                                  revise → [retro × q]
//   Phase sequence = [requirements, scenario0, …, scenario(N-1)], N = scenarios.
//
// HARD BUCKETS, NO CARRYOVER. Each phase is walled off:
//   • overrunning a task never touches another task's budget;
//   • finishing early FORFEITS the unused time (it is NOT rolled forward).
//
//   phaseStart(p)        = wall-clock instant phase p was ENTERED (requirements
//                          = initial_spec entry; scenario idx = that scenario's
//                          scenario_read entry).
//   currentPhase         = the phase of the latest entry.
//   taskRemainingMs      = B_current − (now − phaseStart(current))   // MAY be < 0
//   cumulativeRemainingMs= max(0, taskRemainingMs)
//                          + Σ B_p over phases STRICTLY AFTER current
//                          // completed phases contribute 0 (no carryover); an
//                          // overrun is floored at 0, never refunded.
//
// Logic keeps the sign of taskRemainingMs (the participant's 2-min warning and
// at-0 popup read it). The mm:ss DISPLAY clamps at 0 via `formatRemaining`; the
// underlying signed values are preserved for those thresholds and so the `/live`
// over-budget readout can show a leading `-`.

export const REQUIREMENTS_BUDGET_MS = 10 * 60 * 1000; // 10 min (intro + initial_spec)
export const SCENARIO_BUDGET_MS = 15 * 60 * 1000; // 15 min per scenario

// ============================ Pure timer model ============================

export type TimerPhase =
  | { kind: 'requirements' }
  | { kind: 'scenario'; idx: number };

export type TimerInput = {
  // Per-phase budgets. Defaults are the constants above; passed explicitly so
  // the model is fully pure and the shared fixtures can vary them.
  budgets: { requirementsMs: number; scenarioMs: number };
  // N = number of scenarios in the task. Determines how many SCENARIO phases
  // exist and therefore what "phases after current" sums to.
  scenarioCount: number;
  // Wall-clock instants (ms epoch) each ENTERED phase began. A field/slot left
  // undefined means that phase has not been entered. `scenarios` is sparse by
  // index: scenarios[idx] is scenario idx's entry instant. The latest entered
  // phase (greatest start instant) is the current phase.
  phaseStartsMs: { requirements?: number; scenarios: (number | undefined)[] };
  // "Now" (ms epoch).
  nowMs: number;
};

export type TimerOutput = {
  // The phase of the latest entry, or null if no phase has been entered yet.
  currentPhase: TimerPhase | null;
  // B_current − elapsedInCurrentPhase. MAY be negative. When no phase has been
  // entered, this is the requirements budget at rest (the first thing the
  // participant will spend).
  taskRemainingMs: number;
  // max(0, taskRemainingMs) + Σ budgets of phases strictly after current. Never
  // negative. When no phase has been entered, this is the whole study budget.
  cumulativeRemainingMs: number;
};

// Budget of a given phase under the supplied budgets.
export function budgetOf(phase: TimerPhase, budgets: TimerInput['budgets']): number {
  return phase.kind === 'requirements'
    ? budgets.requirementsMs
    : budgets.scenarioMs;
}

// Sum of budgets for the phases STRICTLY AFTER `current` in the canonical
// sequence [requirements, scenario0, …, scenario(N-1)].
export function budgetAfter(
  current: TimerPhase,
  scenarioCount: number,
  budgets: TimerInput['budgets'],
): number {
  if (current.kind === 'requirements') {
    // All N scenarios are still ahead.
    return scenarioCount * budgets.scenarioMs;
  }
  // Scenarios with index > current.idx are still ahead.
  const remainingScenarios = Math.max(0, scenarioCount - 1 - current.idx);
  return remainingScenarios * budgets.scenarioMs;
}

// Pick the latest-entered phase from the recorded start instants. Ties (equal
// instants) resolve to the later phase in the sequence — a scenario entered at
// the same instant as requirements is treated as the more-advanced current
// phase. Returns null with the entry instant absent when nothing has started.
export function currentPhaseOf(
  phaseStartsMs: TimerInput['phaseStartsMs'],
): { phase: TimerPhase; startedAt: number } | null {
  let best: { phase: TimerPhase; startedAt: number } | null = null;
  const consider = (phase: TimerPhase, startedAt: number | undefined) => {
    if (typeof startedAt !== 'number') return;
    // `>=` so a later phase entered at an equal instant wins (sequence order is
    // requirements, then scenarios ascending — we iterate in that order).
    if (best === null || startedAt >= best.startedAt) {
      best = { phase, startedAt };
    }
  };
  consider({ kind: 'requirements' }, phaseStartsMs.requirements);
  phaseStartsMs.scenarios.forEach((startedAt, idx) =>
    consider({ kind: 'scenario', idx }, startedAt),
  );
  return best;
}

// THE pure model. Given per-phase budgets, the scenario count, each entered
// phase's start instant, and `now`, returns the current phase, the (signed)
// current-task remaining, and the (floored) cumulative remaining.
export function computeTimer(input: TimerInput): TimerOutput {
  const { budgets, scenarioCount, phaseStartsMs, nowMs } = input;
  const current = currentPhaseOf(phaseStartsMs);

  // Idle: nothing entered yet. The first phase the participant will spend is
  // requirements, so the task number shows its full budget and the cumulative
  // shows the whole study (requirements + every scenario).
  if (current === null) {
    return {
      currentPhase: null,
      taskRemainingMs: budgets.requirementsMs,
      cumulativeRemainingMs:
        budgets.requirementsMs + scenarioCount * budgets.scenarioMs,
    };
  }

  const elapsed = nowMs - current.startedAt;
  const taskRemainingMs = budgetOf(current.phase, budgets) - elapsed;
  const cumulativeRemainingMs =
    Math.max(0, taskRemainingMs) +
    budgetAfter(current.phase, scenarioCount, budgets);

  return { currentPhase: current.phase, taskRemainingMs, cumulativeRemainingMs };
}

// ============================ Display helpers ============================

// mm:ss, sign-clamped to 0 (display never shows a negative). Use the signed
// `taskRemainingMs`/`cumulativeRemainingMs` from the model for thresholds and
// for deciding whether to prefix a `-` over-budget marker at the call site.
export function formatRemaining(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

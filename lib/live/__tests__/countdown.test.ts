import { describe, it, expect } from 'vitest';
import {
  computeTimer,
  formatRemaining,
  REQUIREMENTS_BUDGET_MS,
  SCENARIO_BUDGET_MS,
  type TimerInput,
} from '@/lib/live/countdown';
import {
  TIMER_CASES,
  FIXTURE_REQUIREMENTS_BUDGET_MS,
  FIXTURE_SCENARIO_BUDGET_MS,
  type TimerCase,
} from '@/lib/live/__fixtures__/timer-cases';

// ---------------------------------------------------------------------------
// `/live` countdown mirror — asserts the COPIED `computeTimer` reproduces the
// SHARED cross-repo fixtures number-for-number. The fixture file here is a
// verbatim copy of spec-study-app's `lib/study/__fixtures__/timer-cases.ts`;
// spec-study-app's S1 test (`lib/study/__tests__/timer.test.ts`) asserts its
// `computeTimer` against the SAME numbers. If both suites pass, the two repos
// agree number-for-number — that is the contract this test exists to enforce.
// ---------------------------------------------------------------------------

// Translate a shared fixture case into this repo's `computeTimer` input. The
// fixtures are budget/boundary-shaped (no app event types) precisely so both
// repos can adapt them to their own pure function — mirrors S1's `inputFor`.
function inputFor(c: TimerCase): TimerInput {
  return {
    budgets: {
      requirementsMs: c.budgets.requirementsMs,
      scenarioMs: c.budgets.scenarioMs,
    },
    scenarioCount: c.scenarioCount,
    phaseStartsMs: {
      requirements: c.phaseStartsMs.requirements,
      scenarios: c.phaseStartsMs.scenarios,
    },
    nowMs: c.nowMs,
  };
}

describe('budget constants match the cross-repo contract', () => {
  it('REQUIREMENTS_BUDGET_MS = 10 min', () => {
    expect(REQUIREMENTS_BUDGET_MS).toBe(10 * 60 * 1000);
    expect(REQUIREMENTS_BUDGET_MS).toBe(FIXTURE_REQUIREMENTS_BUDGET_MS);
  });
  it('SCENARIO_BUDGET_MS = 15 min', () => {
    expect(SCENARIO_BUDGET_MS).toBe(15 * 60 * 1000);
    expect(SCENARIO_BUDGET_MS).toBe(FIXTURE_SCENARIO_BUDGET_MS);
  });
});

describe('computeTimer — reproduces every shared fixture number-for-number', () => {
  for (const c of TIMER_CASES) {
    it(c.name, () => {
      const out = computeTimer(inputFor(c));
      expect(out.currentPhase).toEqual(c.expect.currentPhase);
      expect(out.taskRemainingMs).toBe(c.expect.taskRemainingMs);
      expect(out.cumulativeRemainingMs).toBe(c.expect.cumulativeRemainingMs);
    });
  }
});

describe('computeTimer — invariants beyond the named fixtures', () => {
  it('cumulativeRemainingMs is the carryover pool — signed, goes negative once the whole budget is spent', () => {
    // On the named fixtures the pool is still positive (finite numbers).
    for (const c of TIMER_CASES) {
      const out = computeTimer(inputFor(c));
      expect(Number.isFinite(out.cumulativeRemainingMs)).toBe(true);
    }
    // Spend the whole pool + 1 min → cumulative is NEGATIVE. The model is NOT
    // floored (carryover); only the mm:ss display clamps at 0.
    const total = REQUIREMENTS_BUDGET_MS + 1 * SCENARIO_BUDGET_MS;
    const spent = computeTimer({
      budgets: { requirementsMs: REQUIREMENTS_BUDGET_MS, scenarioMs: SCENARIO_BUDGET_MS },
      scenarioCount: 1,
      phaseStartsMs: { requirements: 0, scenarios: [REQUIREMENTS_BUDGET_MS] },
      nowMs: total + 60_000,
    });
    expect(spent.cumulativeRemainingMs).toBe(-60_000);
  });

  it('idle (nothing entered) = full study budget; current phase null', () => {
    const out = computeTimer({
      budgets: {
        requirementsMs: REQUIREMENTS_BUDGET_MS,
        scenarioMs: SCENARIO_BUDGET_MS,
      },
      scenarioCount: 2,
      phaseStartsMs: { scenarios: [] },
      nowMs: 1_000_000,
    });
    expect(out.currentPhase).toBeNull();
    expect(out.taskRemainingMs).toBe(REQUIREMENTS_BUDGET_MS);
    expect(out.cumulativeRemainingMs).toBe(
      REQUIREMENTS_BUDGET_MS + 2 * SCENARIO_BUDGET_MS,
    );
  });

  it('latest-entered phase is current (ties resolve to the later phase)', () => {
    // requirements and scenario0 entered at the SAME instant → scenario0 wins.
    const out = computeTimer({
      budgets: {
        requirementsMs: REQUIREMENTS_BUDGET_MS,
        scenarioMs: SCENARIO_BUDGET_MS,
      },
      scenarioCount: 2,
      phaseStartsMs: { requirements: 0, scenarios: [0] },
      nowMs: 0,
    });
    expect(out.currentPhase).toEqual({ kind: 'scenario', idx: 0 });
  });
});

describe('formatRemaining — mm:ss, clamped at 0', () => {
  it('formats whole minutes/seconds', () => {
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(9 * 60 * 1000)).toBe('09:00');
    expect(formatRemaining(10 * 60 * 1000)).toBe('10:00');
    expect(formatRemaining(65 * 1000)).toBe('01:05');
  });

  it('floors sub-second remainders', () => {
    expect(formatRemaining(1999)).toBe('00:01');
  });

  it('clamps negatives to 00:00 (the sign is the caller’s concern)', () => {
    expect(formatRemaining(-1)).toBe('00:00');
    expect(formatRemaining(-180_000)).toBe('00:00');
  });
});

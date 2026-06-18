// ============================================================================
// SHARED TIMER FIXTURES — the CROSS-REPO CONTRACT.
//
// These cases are the single source of truth for the hard-bucket, no-carryover
// participant timer (design: docs/superpowers/specs/2026-06-18-live-timer-and-
// push-design.md). spec-study-app's `lib/study/timer.ts` (S1) is tested against
// them here; the thematic-analysis `/live` mirror (`lib/live/countdown.ts`, T1)
// imports these SAME numbers verbatim. Both repos compute the timer from the
// same `study_events`; they cannot import each other, so the only thing keeping
// them identical number-for-number is this fixture set. Treat every number as a
// frozen contract: changing one means re-deriving BOTH repos.
//
// ---------------------------------------------------------------------------
// THE MODEL (mirrors the spec exactly)
//
// Phases, in order, for a `task` module:
//   REQUIREMENTS (budget `requirementsMs`) = intro + initial_spec
//   SCENARIO idx (budget `scenarioMs`)     = scenario_read → [ponder] → revise
//                                            → [retro × q],  for idx 0..N-1
//   Phase sequence = [requirements, scenario0, …, scenario(N-1)],  N = scenarioCount.
//
// HARD BUCKETS, NO CARRYOVER. Each phase is walled off:
//   • overrunning a task never touches another task's budget;
//   • finishing early FORFEITS the unused time (it is NOT rolled forward).
//
//   phaseStart(p)        = wall-clock instant phase p was ENTERED
//                          (requirements = initial_spec entry; scenario idx =
//                          that scenario's scenario_read entry).
//   currentPhase         = the phase of the latest entry.
//   taskRemainingMs      = B_current − (now − phaseStart(current))   // MAY be < 0
//   cumulativeRemainingMs= max(0, taskRemainingMs)
//                          + Σ B_p over phases STRICTLY AFTER current
//                          // completed phases contribute 0 (no carryover);
//                          // an overrun is floored at 0, never refunded.
//
// Logic keeps the sign of taskRemainingMs (later thresholds: 2-min warning,
// at-0 popup). The mm:ss DISPLAY clamps at 0 — that is a display concern, not
// represented here; these fixtures assert the underlying signed/floored numbers.
//
// currentPhase encoding: { kind: 'requirements' } | { kind: 'scenario', idx }.
// ============================================================================

const MIN = 60 * 1000;
export const FIXTURE_REQUIREMENTS_BUDGET_MS = 10 * MIN; // 600_000
export const FIXTURE_SCENARIO_BUDGET_MS = 15 * MIN; // 900_000

export type FixturePhase =
  | { kind: 'requirements' }
  | { kind: 'scenario'; idx: number };

export type TimerCase = {
  /** Human-readable, self-explanatory case name. */
  name: string;
  /** Per-phase budgets (ms). Same for both repos. */
  budgets: { requirementsMs: number; scenarioMs: number };
  /** N = number of scenarios in the task (1–3). */
  scenarioCount: number;
  /**
   * Wall-clock instants (ms epoch) at which each ENTERED phase began. A phase
   * absent here has not been entered yet. `scenarios` is sparse-by-index:
   * scenarios[idx] is the scenario_read entry instant for scenario idx; an
   * `undefined` slot means that scenario has not been entered. The latest
   * entered phase (greatest start) is the current phase.
   */
  phaseStartsMs: { requirements?: number; scenarios: (number | undefined)[] };
  /** "Now" (ms epoch) at which to evaluate the model. */
  nowMs: number;
  /** Expected outputs of the pure model at `nowMs`. */
  expect: {
    currentPhase: FixturePhase;
    taskRemainingMs: number;
    cumulativeRemainingMs: number;
  };
};

// A common epoch base keeps the arithmetic legible. All instants are offsets
// from T0; every `expect` value is hand-derived from the formulas above and
// annotated so the contract is auditable without running anything.
const T0 = 1_000_000_000_000;
const R = FIXTURE_REQUIREMENTS_BUDGET_MS; // 600_000
const S = FIXTURE_SCENARIO_BUDGET_MS; // 900_000

export const TIMER_CASES: TimerCase[] = [
  // -------------------------------------------------------------------------
  // 1) Start of requirements (2-scenario study). Just entered initial_spec,
  //    no time elapsed. task = full requirements budget; cumulative = that +
  //    both scenarios' full budgets (all phases still ahead/current).
  //    task = R − 0 = 600_000
  //    cumulative = max(0,600_000) + S + S = 600_000 + 900_000 + 900_000
  // -------------------------------------------------------------------------
  {
    name: 'start of requirements (2 scenarios, no time elapsed)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 2,
    phaseStartsMs: { requirements: T0, scenarios: [] },
    nowMs: T0,
    expect: {
      currentPhase: { kind: 'requirements' },
      taskRemainingMs: R, // 600_000
      cumulativeRemainingMs: R + S + S, // 2_400_000
    },
  },

  // -------------------------------------------------------------------------
  // 2) Requirements OVERRUN (2-scenario study). Still on requirements, 13 min
  //    in (3 min past the 10-min budget). task goes NEGATIVE; the overrun is
  //    NOT borrowed from the scenarios — cumulative is exactly both scenarios'
  //    budgets (current floored at 0).
  //    elapsed = 13*MIN = 780_000;  task = 600_000 − 780_000 = −180_000
  //    cumulative = max(0,−180_000) + S + S = 0 + 900_000 + 900_000
  // -------------------------------------------------------------------------
  {
    name: 'requirements overrun (negative task; cumulative = sum of all scenarios)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 2,
    phaseStartsMs: { requirements: T0, scenarios: [] },
    nowMs: T0 + 13 * MIN,
    expect: {
      currentPhase: { kind: 'requirements' },
      taskRemainingMs: R - 13 * MIN, // −180_000
      cumulativeRemainingMs: S + S, // 1_800_000
    },
  },

  // -------------------------------------------------------------------------
  // 3) Finished requirements EARLY, then entered scenario0 (2-scenario study).
  //    Requirements took 6 min (4 min unused → FORFEITED, not rolled forward).
  //    scenario0 entered at T0+6min; now is 5 min into scenario0.
  //    Current = scenario0. task = S − 5*MIN = 900_000 − 300_000 = 600_000.
  //    cumulative = max(0,600_000) + S (scenario1 still ahead) = 600_000 + 900_000.
  //    The forfeited 4 min of requirements is GONE — cumulative dropped from
  //    the would-be 2_400_000 at study start to 1_500_000 (NOT 1_500_000+240_000).
  // -------------------------------------------------------------------------
  {
    name: 'finished requirements early then entered scenario0 (forfeit; cumulative dropped)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 2,
    phaseStartsMs: { requirements: T0, scenarios: [T0 + 6 * MIN] },
    nowMs: T0 + 6 * MIN + 5 * MIN,
    expect: {
      currentPhase: { kind: 'scenario', idx: 0 },
      taskRemainingMs: S - 5 * MIN, // 600_000
      cumulativeRemainingMs: S - 5 * MIN + S, // 1_500_000
    },
  },

  // -------------------------------------------------------------------------
  // 4) Mid-scenario (3-scenario study, on scenario1). Requirements + scenario0
  //    already completed (contribute 0). scenario1 entered, 7 min in.
  //    current = scenario1. task = S − 7*MIN = 900_000 − 420_000 = 480_000.
  //    cumulative = max(0,480_000) + S (scenario2 ahead) = 480_000 + 900_000.
  // -------------------------------------------------------------------------
  {
    name: 'mid-scenario (3 scenarios, on scenario1, 7 min in)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 3,
    phaseStartsMs: {
      requirements: T0,
      // scenario0 entered at +9min, scenario1 entered at +16min (latest = current)
      scenarios: [T0 + 9 * MIN, T0 + 16 * MIN],
    },
    nowMs: T0 + 16 * MIN + 7 * MIN,
    expect: {
      currentPhase: { kind: 'scenario', idx: 1 },
      taskRemainingMs: S - 7 * MIN, // 480_000
      cumulativeRemainingMs: S - 7 * MIN + S, // 1_380_000
    },
  },

  // -------------------------------------------------------------------------
  // 5) LAST-scenario OVERRUN (2-scenario study, on scenario1 = last). 18 min
  //    into the last scenario (3 min past its 15-min budget). No phases after
  //    current, so cumulative FLOORS at 0 (overrun not refunded).
  //    task = S − 18*MIN = 900_000 − 1_080_000 = −180_000.
  //    cumulative = max(0,−180_000) + 0 = 0.
  // -------------------------------------------------------------------------
  {
    name: 'last-scenario overrun (cumulative floors at 0)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 2,
    phaseStartsMs: {
      requirements: T0,
      scenarios: [T0 + 8 * MIN, T0 + 20 * MIN], // scenario1 latest = current
    },
    nowMs: T0 + 20 * MIN + 18 * MIN,
    expect: {
      currentPhase: { kind: 'scenario', idx: 1 },
      taskRemainingMs: S - 18 * MIN, // −180_000
      cumulativeRemainingMs: 0,
    },
  },

  // -------------------------------------------------------------------------
  // 6) ONE-scenario study, on the single scenario, 4 min in. Only phase after
  //    requirements; nothing ahead of it.
  //    task = S − 4*MIN = 900_000 − 240_000 = 660_000.
  //    cumulative = max(0,660_000) + 0 = 660_000.
  // -------------------------------------------------------------------------
  {
    name: '1-scenario study (on scenario0, 4 min in)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 1,
    phaseStartsMs: { requirements: T0, scenarios: [T0 + 7 * MIN] },
    nowMs: T0 + 7 * MIN + 4 * MIN,
    expect: {
      currentPhase: { kind: 'scenario', idx: 0 },
      taskRemainingMs: S - 4 * MIN, // 660_000
      cumulativeRemainingMs: S - 4 * MIN, // 660_000
    },
  },

  // -------------------------------------------------------------------------
  // 7) THREE-scenario study, start of scenario0 (just entered scenario_read,
  //    requirements completed). current = scenario0, no elapsed time.
  //    task = S − 0 = 900_000.
  //    cumulative = max(0,900_000) + S + S (scenarios 1 and 2 ahead)
  //               = 900_000 + 900_000 + 900_000.
  // -------------------------------------------------------------------------
  {
    name: '3-scenario study (start of scenario0)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 3,
    phaseStartsMs: { requirements: T0, scenarios: [T0 + 10 * MIN] },
    nowMs: T0 + 10 * MIN,
    expect: {
      currentPhase: { kind: 'scenario', idx: 0 },
      taskRemainingMs: S, // 900_000
      cumulativeRemainingMs: S + S + S, // 2_700_000
    },
  },
];

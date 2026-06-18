// ============================================================================
// SHARED TIMER FIXTURES — the CROSS-REPO CONTRACT.
//
// Single source of truth for the participant timer (design: docs/superpowers/
// specs/2026-06-18-live-timer-and-push-design.md). spec-study-app's
// `lib/study/timer.ts` is tested against them here; the thematic-analysis `/live`
// mirror (`lib/live/countdown.ts`) imports these SAME numbers verbatim. Both repos
// compute the timer from the same `study_events`; they cannot import each other,
// so this fixture set is the only thing keeping them identical number-for-number.
// Treat every number as a frozen contract: changing one means re-deriving BOTH repos.
//
// ---------------------------------------------------------------------------
// THE MODEL (mirrors the spec exactly) — HYBRID: per-task buckets + POOLED total.
//
// Phases, in order, for a `task` module:
//   REQUIREMENTS (budget `requirementsMs`) = intro + initial_spec
//   SCENARIO idx (budget `scenarioMs`)     = scenario_read → [ponder] → revise
//                                            → [retro × q],  for idx 0..N-1
//   Phase sequence = [requirements, scenario0, …, scenario(N-1)],  N = scenarioCount.
//
// PER-TASK buckets are ADVISORY pacing; the TOTAL is one POOL with CARRYOVER:
//   phaseStart(p)        = wall-clock instant phase p was ENTERED (requirements
//                          = initial_spec entry; scenario idx = scenario_read).
//   currentPhase         = the phase of the latest entry.
//   taskRemainingMs      = B_current − (now − phaseStart(current))   // MAY be < 0 (advisory)
//   cumulativeRemainingMs= totalBudget − (now − firstPhaseStart)
//                          // totalBudget = requirements + every scenario.
//                          // The POOL carries unused per-task time FORWARD — it
//                          // is NOT forfeited at a boundary and an overrun is NOT
//                          // floored; the participant gets the full budget
//                          // (e.g. 10 + 4×15 = 70 min) however they spread it.
//                          // Signed; the mm:ss DISPLAY clamps at 0.
//
// Logic keeps the sign of taskRemainingMs (2-min warning, at-0 popup). These
// fixtures assert the underlying signed numbers; display-clamping is not modeled here.
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
  /** N = number of scenarios in the task (1–4). */
  scenarioCount: number;
  /**
   * Wall-clock instants (ms epoch) at which each ENTERED phase began. A phase
   * absent here has not been entered yet. `scenarios` is sparse-by-index. The
   * earliest entered phase is `firstPhaseStart` (the pool's t=0); the latest is
   * the current phase.
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
// Requirements is entered at T0 in every case, so firstPhaseStart = T0 and the
// pool's elapsed = (now − T0).
const T0 = 1_000_000_000_000;
const R = FIXTURE_REQUIREMENTS_BUDGET_MS; // 600_000
const S = FIXTURE_SCENARIO_BUDGET_MS; // 900_000

export const TIMER_CASES: TimerCase[] = [
  // -------------------------------------------------------------------------
  // 1) Start of requirements (2-scenario study). Just entered initial_spec,
  //    no time elapsed. task = full requirements budget; cumulative = the whole
  //    pool (requirements + both scenarios), nothing spent yet.
  //    task = R − 0 = 600_000
  //    cumulative = (R + 2S) − 0 = 2_400_000
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
      cumulativeRemainingMs: R + 2 * S, // 2_400_000 (pool − 0)
    },
  },

  // -------------------------------------------------------------------------
  // 2) Requirements OVERRUN (2-scenario study). Still on requirements, 13 min
  //    in (3 min past the 10-min task budget). task goes NEGATIVE (advisory).
  //    The overrun simply DRAWS DOWN the shared pool — not floored.
  //    elapsed = 13min;  task = R − 13min = −180_000
  //    cumulative = (R + 2S) − 13min = 2_400_000 − 780_000 = 1_620_000
  // -------------------------------------------------------------------------
  {
    name: 'requirements overrun (negative task; pool drawn down, not floored)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 2,
    phaseStartsMs: { requirements: T0, scenarios: [] },
    nowMs: T0 + 13 * MIN,
    expect: {
      currentPhase: { kind: 'requirements' },
      taskRemainingMs: R - 13 * MIN, // −180_000
      cumulativeRemainingMs: R + 2 * S - 13 * MIN, // 1_620_000
    },
  },

  // -------------------------------------------------------------------------
  // 3) Finished requirements EARLY, then entered scenario0 (2-scenario study).
  //    Requirements took 6 min; scenario0 entered at T0+6min; now 5 min into it.
  //    task = S − 5min = 600_000.
  //    CARRYOVER: the 4 unused requirements minutes are RETAINED in the pool —
  //    cumulative = (R + 2S) − 11min = 2_400_000 − 660_000 = 1_740_000
  //    (NOT 1_500_000, which is what hard-bucket forfeiting would give.)
  // -------------------------------------------------------------------------
  {
    name: 'finished requirements early then scenario0 (CARRYOVER: unused time retained)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 2,
    phaseStartsMs: { requirements: T0, scenarios: [T0 + 6 * MIN] },
    nowMs: T0 + 6 * MIN + 5 * MIN,
    expect: {
      currentPhase: { kind: 'scenario', idx: 0 },
      taskRemainingMs: S - 5 * MIN, // 600_000
      cumulativeRemainingMs: R + 2 * S - 11 * MIN, // 1_740_000
    },
  },

  // -------------------------------------------------------------------------
  // 4) Mid-scenario (3-scenario study, on scenario1, 7 min in). requirements +
  //    scenario0 already spent; pool counts total elapsed from T0.
  //    task = S − 7min = 480_000.
  //    cumulative = (R + 3S) − 23min = 3_300_000 − 1_380_000 = 1_920_000
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
      cumulativeRemainingMs: R + 3 * S - 23 * MIN, // 1_920_000
    },
  },

  // -------------------------------------------------------------------------
  // 5) LAST-scenario OVERRUN (2-scenario study, on scenario1 = last). 18 min
  //    into the last scenario (3 min past its 15-min bucket → task negative).
  //    But earlier phases UNDER-ran, so the POOL is still positive — NOT floored.
  //    task = S − 18min = −180_000.
  //    cumulative = (R + 2S) − 38min = 2_400_000 − 2_280_000 = 120_000
  // -------------------------------------------------------------------------
  {
    name: 'last-scenario overrun (task negative; pool still positive via carryover)',
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
      cumulativeRemainingMs: R + 2 * S - 38 * MIN, // 120_000
    },
  },

  // -------------------------------------------------------------------------
  // 6) ONE-scenario study, on the single scenario, 4 min in.
  //    task = S − 4min = 660_000.
  //    cumulative = (R + S) − 11min = 1_500_000 − 660_000 = 840_000
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
      cumulativeRemainingMs: R + S - 11 * MIN, // 840_000
    },
  },

  // -------------------------------------------------------------------------
  // 7) THREE-scenario study, start of scenario0 (requirements took exactly
  //    10 min, scenario0 just entered, no elapsed in it).
  //    task = S − 0 = 900_000.
  //    cumulative = (R + 3S) − 10min = 3_300_000 − 600_000 = 2_700_000
  // -------------------------------------------------------------------------
  {
    name: '3-scenario study (start of scenario0, requirements fully used)',
    budgets: { requirementsMs: R, scenarioMs: S },
    scenarioCount: 3,
    phaseStartsMs: { requirements: T0, scenarios: [T0 + 10 * MIN] },
    nowMs: T0 + 10 * MIN,
    expect: {
      currentPhase: { kind: 'scenario', idx: 0 },
      taskRemainingMs: S, // 900_000
      cumulativeRemainingMs: R + 3 * S - 10 * MIN, // 2_700_000
    },
  },
];

// The four authored study scenarios as ScenarioSetup fixtures, plus the
// reference end-state checks the execution grader (B2-3) compares against.
//
// Each fixture is DERIVED from the authored study content's Given/When
// clauses (derivations follow plan 2026-07-04-eval-harness-b2-graders.md,
// §B2-1 "Scenario fixtures"). Where a Given describes mid-ride state that the
// ScenarioSetup vocabulary cannot express directly ("has picked up Rider A",
// "just dropped A"), the fixture REPLAYS that ride via `preassigned` +
// requestAtMin 0: the sim reproduces the authored state on its way to the
// scenario's decision point, and the end-state checks (servedBy/droppedAt)
// come out identical to the authored narrative.

import type { LandmarkName, RiderId, ScenarioSetup, VehicleId } from './harness';

export const SCENARIOS: readonly [ScenarioSetup, ScenarioSetup, ScenarioSetup, ScenarioSetup] = [
  // S0 (authored Scenario 1): Given V1 is "driving past Lane Field" at B's
  // request time — the fixture places it AT Lane Field, battery 100. Rider A
  // requests first (Executive Airport → Newman Library, t=0); B requests at
  // Lane Field → Executive Airport at t=10. No V2 in this scenario. The
  // authored Then expects B picked up first (V1 is right there), then A.
  {
    scenarioIdx: 0,
    vehicles: [{ id: 'V1', start: 'Lane Field', battery: 100 }],
    riders: [
      { id: 'A', pickup: 'Executive Airport', dropoff: 'Newman Library', requestAtMin: 0 },
      { id: 'B', pickup: 'Lane Field', dropoff: 'Executive Airport', requestAtMin: 10 },
    ],
  },
  // S1 (authored Scenario 2): Given V1 "has picked up Rider A" at Executive
  // Airport — represented as A preassigned to V1 with requestAtMin 0 and V1
  // starting AT A's pickup, so the sim picks A up immediately at t=0 (a
  // zero-distance leg). V2 idles at the Depot. B requests Lane Field →
  // Executive Airport at t=15; the authored When also has V2 repositioned to
  // ASCEND³ as a staging move.
  {
    scenarioIdx: 1,
    vehicles: [
      { id: 'V1', start: 'Executive Airport', battery: 100 },
      { id: 'V2', start: 'Depot / Charging', battery: 100 },
    ],
    riders: [
      { id: 'A', pickup: 'Executive Airport', dropoff: 'Newman Library', requestAtMin: 0 },
      { id: 'B', pickup: 'Lane Field', dropoff: 'Executive Airport', requestAtMin: 15 },
    ],
    preassigned: [{ rider: 'A', vehicle: 'V1' }],
  },
  // S2 (authored Scenario 3): Given V1 "just dropped A" at Newman Library —
  // A's ride is replayed (preassigned to V1, Executive Airport → Newman
  // Library, t=0; V1 starts at Newman Library per the Given, so the replay
  // drives out and back). Given B is "in V1's queue" — preassigned behind A
  // (ASCEND³ → Executive Airport, t=0). V2 idles at the Depot. C requests
  // Newman Library → Lane Field at t=5: the scenario's decision point.
  {
    scenarioIdx: 2,
    vehicles: [
      { id: 'V1', start: 'Newman Library', battery: 100 },
      { id: 'V2', start: 'Depot / Charging', battery: 100 },
    ],
    riders: [
      { id: 'A', pickup: 'Executive Airport', dropoff: 'Newman Library', requestAtMin: 0 },
      { id: 'B', pickup: 'ASCEND³', dropoff: 'Executive Airport', requestAtMin: 0 },
      { id: 'C', pickup: 'Newman Library', dropoff: 'Lane Field', requestAtMin: 5 },
    ],
    preassigned: [
      { rider: 'A', vehicle: 'V1' },
      { rider: 'B', vehicle: 'V1' },
    ],
  },
  // S3 (authored Scenario 4): Given V1 is carrying A (Executive Airport →
  // Newman Library, preassigned, t=0) on battery 20, with B (Lane Field →
  // ASCEND³, t=0) queued behind. Battery 20 minus the 21-unit Newman Library
  // leg crosses below the 15% operating threshold (a WORLD fact — what the
  // policy does about it is what's being graded), so low_battery fires right
  // after A's dropoff — matching the authored When. V2 sits fresh at the
  // Depot.
  {
    scenarioIdx: 3,
    vehicles: [
      { id: 'V1', start: 'Executive Airport', battery: 20 },
      { id: 'V2', start: 'Depot / Charging', battery: 100 },
    ],
    riders: [
      { id: 'A', pickup: 'Executive Airport', dropoff: 'Newman Library', requestAtMin: 0 },
      { id: 'B', pickup: 'Lane Field', dropoff: 'ASCEND³', requestAtMin: 0 },
    ],
    preassigned: [
      { rider: 'A', vehicle: 'V1' },
      { rider: 'B', vehicle: 'V1' },
    ],
  },
];

/** Reference end-state CHECKS as data: what the authored expected behavior
 *  (REFERENCE_POLICY in sim.test.ts) produces, reduced to the fields the
 *  execution grader scores — per-rider servedBy/droppedAt, per-vehicle
 *  charged, and (S0 only, where the authored Then constrains it) the global
 *  pickup order. */
export type ExpectedEndState = {
  riders: { id: RiderId; servedBy: VehicleId | null; droppedAt: LandmarkName | null }[];
  vehicles: { id: VehicleId; charged: boolean }[];
  /** Rider ids in global pickup order, present only when the scenario's
   *  authored clauses pin the ordering. */
  pickupOrder?: RiderId[];
};

// Written from the plan's golden-test expectations (§B2-1 golden test 1) —
// NOT generated by running the sim. The golden suite closes the loop by
// asserting REFERENCE_POLICY's actual end states agree with this data, which
// is what licenses the execution grader to score against it.
export const EXPECTED_END_STATES: readonly [
  ExpectedEndState,
  ExpectedEndState,
  ExpectedEndState,
  ExpectedEndState,
] = [
  // S0: B first (V1 is at Lane Field), then A; both served by V1.
  {
    riders: [
      { id: 'A', servedBy: 'V1', droppedAt: 'Newman Library' },
      { id: 'B', servedBy: 'V1', droppedAt: 'Executive Airport' },
    ],
    vehicles: [{ id: 'V1', charged: false }],
    pickupOrder: ['B', 'A'],
  },
  // S1: V1 serves both riders; V2 only repositions (never picks up, never charges).
  {
    riders: [
      { id: 'A', servedBy: 'V1', droppedAt: 'Newman Library' },
      { id: 'B', servedBy: 'V1', droppedAt: 'Executive Airport' },
    ],
    vehicles: [
      { id: 'V1', charged: false },
      { id: 'V2', charged: false },
    ],
  },
  // S2: B handed off to V2; C served by V1.
  {
    riders: [
      { id: 'A', servedBy: 'V1', droppedAt: 'Newman Library' },
      { id: 'B', servedBy: 'V2', droppedAt: 'Executive Airport' },
      { id: 'C', servedBy: 'V1', droppedAt: 'Lane Field' },
    ],
    vehicles: [
      { id: 'V1', charged: false },
      { id: 'V2', charged: false },
    ],
  },
  // S3: V1 sheds B to V2 and charges.
  {
    riders: [
      { id: 'A', servedBy: 'V1', droppedAt: 'Newman Library' },
      { id: 'B', servedBy: 'V2', droppedAt: 'ASCEND³' },
    ],
    vehicles: [
      { id: 'V1', charged: true },
      { id: 'V2', charged: false },
    ],
  },
];

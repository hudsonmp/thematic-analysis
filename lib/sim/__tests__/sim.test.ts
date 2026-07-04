// Golden tests for the deterministic rideshare simulator (Task B2-1).
//
// THESE TESTS ARE THE SIM SPEC (plan 2026-07-04-eval-harness-b2-graders.md,
// §B2-1 "Golden tests"). REFERENCE_POLICY transcribes the authored expected
// dispatcher behavior for the four study scenarios; NAIVE_POLICY is the
// deliberately wrong baseline (assign everything to V1, ignore low_battery)
// whose end states must DIFFER from the reference where the plan says so.
// Everything here is TRUSTED test code — untrusted (LLM-generated) policies
// never run in-process; they go through the B2-2 sandbox.

import { describe, expect, it } from 'vitest';
import {
  runScenario,
  type EndState,
  type PolicyAction,
  type PolicyFn,
  type SimEvent,
} from '../harness';
import { SIM_JS } from '../sim-source';
import { EXPECTED_END_STATES, SCENARIOS, type ExpectedEndState } from '../scenarios';

function riderOf(end: EndState, id: string) {
  const r = end.riders.find((x) => x.id === id);
  if (!r) throw new Error(`rider ${id} missing from end state`);
  return r;
}

function vehicleOf(end: EndState, id: string) {
  const v = end.vehicles.find((x) => x.id === id);
  if (!v) throw new Error(`vehicle ${id} missing from end state`);
  return v;
}

/** Assert an EndState satisfies a scenario's reference checks-as-data. This is
 *  the loop-closer the plan requires: EXPECTED_END_STATES was written from the
 *  golden expectations below, and this helper proves the sim's actual
 *  reference-policy output agrees with that data (which B2-3's execution
 *  grader will reuse as its comparison target). */
function expectMatchesChecks(end: EndState, checks: ExpectedEndState) {
  for (const rc of checks.riders) {
    const r = riderOf(end, rc.id);
    expect(r.servedBy, `rider ${rc.id} servedBy`).toBe(rc.servedBy);
    expect(r.droppedAt, `rider ${rc.id} droppedAt`).toBe(rc.droppedAt);
  }
  for (const vc of checks.vehicles) {
    expect(vehicleOf(end, vc.id).charged, `vehicle ${vc.id} charged`).toBe(vc.charged);
  }
  if (checks.pickupOrder) {
    const order = end.riders
      .filter((r) => r.pickupOrder !== null)
      .sort((a, b) => (a.pickupOrder as number) - (b.pickupOrder as number))
      .map((r) => r.id);
    expect(order, 'global pickup order').toEqual(checks.pickupOrder);
  }
}

// The authored expected behavior, one PolicyFn per scenario (plan golden test 1).
const REFERENCE_POLICY: Record<0 | 1 | 2 | 3, PolicyFn> = {
  // S0 — authored: V1 is "driving past Lane Field" when B requests there, so B
  // is picked up FIRST even though A requested 10 minutes earlier. The policy
  // realizes the B-first interleave by holding A's request until B's arrives,
  // then queueing B ahead of A: B is a zero-distance pickup at Lane Field,
  // B's dropoff (Executive Airport) is exactly A's pickup, then A rides to
  // Newman Library.
  0: (_world, event) => {
    if (event.type === 'ride_request' && event.rider === 'B') {
      return [
        { act: 'assign', vehicle: 'V1', rider: 'B' },
        { act: 'assign', vehicle: 'V1', rider: 'A' },
      ];
    }
    return [{ act: 'noop' }];
  },
  // S1 — assign B to V1 (it finishes A's ride first, FIFO), and reposition the
  // idle V2 to ASCEND³ as a staging move. Deliberately UNGUARDED: when V2
  // idles again after arriving at ASCEND³, the policy re-issues the same
  // reposition — exercising the sim's same-place-reposition noop rule (the
  // livelock guard; without it this would spin to the step cap).
  1: (_world, event) => {
    if (event.type === 'ride_request' && event.rider === 'B') {
      return [{ act: 'assign', vehicle: 'V1', rider: 'B' }];
    }
    if (event.type === 'idle' && event.vehicle === 'V2') {
      return [{ act: 'reposition', vehicle: 'V2', to: 'ASCEND³' }];
    }
    return [];
  },
  // S2 — on C's request: hand B (still queued behind A on V1) to V2, and give
  // C to V1: C's pickup (Newman Library) is exactly where V1 drops A.
  2: (_world, event) => {
    if (event.type === 'ride_request' && event.rider === 'C') {
      return [
        { act: 'reassign', rider: 'B', to: 'V2' },
        { act: 'assign', vehicle: 'V1', rider: 'C' },
      ];
    }
    return [];
  },
  // S3 — on low_battery (fires after A's dropoff at Newman Library): shed the
  // still-queued B to V2 and send V1 to the Depot to charge.
  3: (_world, event) => {
    if (event.type === 'low_battery' && event.vehicle === 'V1') {
      return [
        { act: 'reassign', rider: 'B', to: 'V2' },
        { act: 'charge', vehicle: 'V1' },
      ];
    }
    return [];
  },
};

// The wrong-baseline policy (plan golden test 2): assign every request to V1,
// ignore low_battery entirely. On S2/S3 the preassigned riders make its
// assigns duplicates — which the sim must IGNORE with a log line, not honor.
const NAIVE_POLICY: PolicyFn = (_world, event) =>
  event.type === 'ride_request'
    ? [{ act: 'assign', vehicle: 'V1', rider: event.rider }]
    : [];

describe('harness', () => {
  it('rejects a non-function policy', () => {
    expect(() => runScenario(SCENARIOS[0], 'not a policy' as unknown as PolicyFn)).toThrow(
      /function/i,
    );
  });

  it('SIM_JS is plain, dependency-free, deterministic JavaScript', () => {
    // The sim string ships verbatim into sandbox scripts (B2-2): no module
    // loads, no wall clock, no randomness, no template-literal syntax that
    // would fight the carrier template literal.
    expect(SIM_JS).not.toMatch(/\brequire\s*\(/);
    expect(SIM_JS).not.toMatch(/\bimport\b/);
    expect(SIM_JS).not.toMatch(/Date\.now|Math\.random/);
    expect(SIM_JS).not.toContain('`');
    expect(SIM_JS).not.toContain('${');
    expect(SIM_JS).toContain('module.exports = { runScenario }');
  });
});

describe('REFERENCE_POLICY (golden)', () => {
  it('S0: B-first interleave — B dropped at Executive Airport (pickup 0), A at Newman Library (pickup 1), both by V1', () => {
    const end = runScenario(SCENARIOS[0], REFERENCE_POLICY[0]);
    expect(end.completed).toBe(true);
    const a = riderOf(end, 'A');
    const b = riderOf(end, 'B');
    expect(b.servedBy).toBe('V1');
    expect(b.droppedAt).toBe('Executive Airport');
    expect(b.pickupOrder).toBe(0);
    expect(a.servedBy).toBe('V1');
    expect(a.droppedAt).toBe('Newman Library');
    expect(a.pickupOrder).toBe(1);
    // Drain audit: 1 %/unit over Lane Field→Executive Airport (7.8) +
    // Executive Airport→Newman Library (21); both pickups are zero-distance.
    expect(vehicleOf(end, 'V1').battery).toBeCloseTo(100 - 7.8 - 21, 6);
  });

  it('S1: B served by V1; V2 repositioned to ASCEND³ and never picks up', () => {
    const end = runScenario(SCENARIOS[1], REFERENCE_POLICY[1]);
    expect(end.completed).toBe(true);
    expect(riderOf(end, 'A').servedBy).toBe('V1');
    expect(riderOf(end, 'A').droppedAt).toBe('Newman Library');
    expect(riderOf(end, 'B').servedBy).toBe('V1');
    expect(riderOf(end, 'B').droppedAt).toBe('Executive Airport');
    expect(end.riders.every((r) => r.servedBy === 'V1')).toBe(true);
    expect(vehicleOf(end, 'V2').at).toBe('ASCEND³');
    // The unguarded second reposition (V2 already at ASCEND³) must be a logged
    // noop, not a zero-length drive loop.
    expect(end.log.some((l) => /already there/.test(l))).toBe(true);
    expect(vehicleOf(end, 'V1').battery).toBeCloseTo(100 - 21 - 13.4 - 7.8, 6);
    expect(vehicleOf(end, 'V2').battery).toBeCloseTo(100 - 10.7, 6);
  });

  it('S2: B reassigned to V2; C served by V1 and dropped at Lane Field', () => {
    const end = runScenario(SCENARIOS[2], REFERENCE_POLICY[2]);
    expect(end.completed).toBe(true);
    expect(riderOf(end, 'C').servedBy).toBe('V1');
    expect(riderOf(end, 'C').droppedAt).toBe('Lane Field');
    expect(riderOf(end, 'B').servedBy).toBe('V2');
    expect(riderOf(end, 'B').droppedAt).toBe('Executive Airport');
    expect(riderOf(end, 'A').servedBy).toBe('V1');
  });

  it('S3: V1 charges at the Depot; B served by V2 and dropped at ASCEND³', () => {
    const end = runScenario(SCENARIOS[3], REFERENCE_POLICY[3]);
    expect(end.completed).toBe(true);
    const v1 = vehicleOf(end, 'V1');
    expect(v1.at).toBe('Depot / Charging');
    expect(v1.charged).toBe(true);
    expect(v1.battery).toBe(100);
    expect(riderOf(end, 'B').servedBy).toBe('V2');
    expect(riderOf(end, 'B').droppedAt).toBe('ASCEND³');
    expect(riderOf(end, 'A').servedBy).toBe('V1');
    expect(riderOf(end, 'A').droppedAt).toBe('Newman Library');
  });

  it('agrees with EXPECTED_END_STATES on every scenario', () => {
    for (const idx of [0, 1, 2, 3] as const) {
      const end = runScenario(SCENARIOS[idx], REFERENCE_POLICY[idx]);
      expectMatchesChecks(end, EXPECTED_END_STATES[idx]);
    }
  });
});

describe('NAIVE_POLICY (golden)', () => {
  it('S2: no reassignment — B stays served by V1 (differs from reference)', () => {
    const end = runScenario(SCENARIOS[2], NAIVE_POLICY);
    expect(end.completed).toBe(true);
    expect(riderOf(end, 'B').servedBy).toBe('V1');
    // Its duplicate assigns of the preassigned riders must be ignored WITH a
    // log line (world rule: illegal actions are signal, never throws).
    expect(end.log.some((l) => /ignored illegal action/.test(l))).toBe(true);
  });

  it('S3: ignores low_battery — V1 never charges and B stays served by V1', () => {
    const end = runScenario(SCENARIOS[3], NAIVE_POLICY);
    expect(end.completed).toBe(true);
    expect(vehicleOf(end, 'V1').charged).toBe(false);
    expect(riderOf(end, 'B').servedBy).toBe('V1');
  });
});

describe('determinism', () => {
  it('two runs of the same (setup, policy) give deep-equal EndStates', () => {
    for (const idx of [0, 1, 2, 3] as const) {
      const first = runScenario(SCENARIOS[idx], REFERENCE_POLICY[idx]);
      const second = runScenario(SCENARIOS[idx], REFERENCE_POLICY[idx]);
      expect(second).toEqual(first);
    }
    // Also with the naive policy (exercises the ignored-duplicate-assign path
    // twice against the SAME fixture objects — proves the sim never mutates
    // its input setup).
    expect(runScenario(SCENARIOS[2], NAIVE_POLICY)).toEqual(runScenario(SCENARIOS[2], NAIVE_POLICY));
  });
});

describe('hostile policies', () => {
  it('garbage actions are ignored with log lines and the sim completes', () => {
    const garbage = [
      42,
      null,
      'drive fast',
      { act: 'teleport', vehicle: 'V1' },
      { act: 'assign', vehicle: 'V9', rider: 'A' },
      { act: 'assign', vehicle: 'V1', rider: 'Z' },
      { act: 'reassign', rider: 'A', to: 'V1' }, // A is unassigned in S0 — illegal
      { act: 'reposition', vehicle: 'V1', to: 'Atlantis' },
    ] as unknown as PolicyAction[];
    const hostile: PolicyFn = () => garbage;
    const end = runScenario(SCENARIOS[0], hostile);
    expect(end.completed).toBe(true);
    expect(end.riders.every((r) => r.servedBy === null)).toBe(true);
    expect(end.log.filter((l) => /ignored illegal action/.test(l)).length).toBeGreaterThanOrEqual(3);
  });

  it('a throwing policy is caught per-event, logged, and treated as noop', () => {
    const thrower: PolicyFn = () => {
      throw new Error('kaboom');
    };
    const end = runScenario(SCENARIOS[0], thrower);
    expect(end.completed).toBe(true);
    expect(end.riders.every((r) => r.servedBy === null)).toBe(true);
    expect(end.log.filter((l) => /policy exception/.test(l)).length).toBeGreaterThanOrEqual(2);
  });

  it('a non-array return is logged and treated as noop', () => {
    const nonArray = (() => ({ act: 'noop' })) as unknown as PolicyFn;
    const end = runScenario(SCENARIOS[0], nonArray);
    expect(end.completed).toBe(true);
    expect(end.riders.every((r) => r.servedBy === null)).toBe(true);
    expect(end.log.some((l) => /non-array/.test(l))).toBe(true);
  });
});

describe('world rules: battery + low_battery', () => {
  it('S3: V1 battery decreases monotonically along its route, floors at 0, and low_battery fires exactly once', () => {
    const readings: { event: SimEvent['type']; battery: number }[] = [];
    const probe: PolicyFn = (world, event) => {
      const v1 = world.vehicles.find((v) => v.id === 'V1');
      if (v1) readings.push({ event: event.type, battery: v1.battery });
      return REFERENCE_POLICY[3](world, event);
    };
    const end = runScenario(SCENARIOS[3], probe);
    expect(end.completed).toBe(true);

    // Exactly one low_battery event, ever (edge-triggered on crossing 15).
    expect(readings.filter((r) => r.event === 'low_battery')).toHaveLength(1);
    expect(end.log.filter((l) => /event: low_battery/.test(l))).toHaveLength(1);

    // Battery is monotonically non-increasing up to the low_battery event,
    // with a strict overall decrease: 20 at the start, 0 (floored — the
    // Executive Airport→Newman Library leg costs 21 units against 20%)
    // by the time low_battery fires. Never negative.
    const lbIdx = readings.findIndex((r) => r.event === 'low_battery');
    const route = readings.slice(0, lbIdx + 1).map((r) => r.battery);
    expect(route[0]).toBe(20);
    expect(route[route.length - 1]).toBe(0);
    for (let i = 1; i < route.length; i++) {
      expect(route[i]).toBeLessThanOrEqual(route[i - 1]);
    }
    expect(readings.every((r) => r.battery >= 0)).toBe(true);

    // Per-arrival trace agrees: the only positive-distance leg before the
    // charge strictly drains the battery.
    const arrivals = end.log
      .filter((l) => / V1 arrived at /.test(l))
      .map((l) => Number(/battery ([\d.]+)%/.exec(l)?.[1]));
    expect(arrivals[1]).toBeLessThan(arrivals[0] as number);

    // After the charge action completes: full battery, flagged, at the Depot.
    const v1 = vehicleOf(end, 'V1');
    expect(v1.battery).toBe(100);
    expect(v1.charged).toBe(true);
    expect(v1.at).toBe('Depot / Charging');
  });
});

describe('world rules: step cap', () => {
  it('a reposition ping-pong trips the 500-step cap with completed:false', () => {
    const pingPong: PolicyFn = (world, event) => {
      if (event.type !== 'idle') return [];
      const v = world.vehicles.find((x) => x.id === event.vehicle);
      if (!v) return [];
      return [
        {
          act: 'reposition',
          vehicle: event.vehicle,
          to: v.at === 'Depot / Charging' ? 'Newman Library' : 'Depot / Charging',
        },
      ];
    };
    const end = runScenario(SCENARIOS[1], pingPong);
    expect(end.completed).toBe(false);
    expect(end.log.some((l) => /step cap/.test(l))).toBe(true);
  });
});

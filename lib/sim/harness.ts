// In-process harness over SIM_JS: TypeScript types for the sim contract plus
// a typed `runScenario` wrapper around the evaluated plain-JS module.
//
// SECURITY BOUNDARY (plan Global Constraints — documented here and in
// sim-source.ts): the `new Function(...)` evaluation below is allowed ONLY for
// the TRUSTED sim string and the TRUSTED policies our own tests pass in.
// Untrusted code — anything an LLM generated from a participant spec — must
// NEVER reach this module: it runs exclusively inside the B2-2 sandbox child
// process (env-cleared, timeboxed, output-capped). If you are about to call
// this `runScenario` with generated policy code, stop and use the sandbox.

import { SIM_JS } from './sim-source';

export type LandmarkName =
  | 'Depot / Charging'
  | 'Newman Library'
  | 'Lane Field'
  | 'Executive Airport'
  | 'ASCEND³';
export type VehicleId = 'V1' | 'V2';
export type RiderId = 'A' | 'B' | 'C';

export type ScenarioSetup = {
  scenarioIdx: 0 | 1 | 2 | 3;
  vehicles: { id: VehicleId; start: LandmarkName; battery: number }[]; // battery 0..100
  riders: { id: RiderId; pickup: LandmarkName; dropoff: LandmarkName; requestAtMin: number }[];
  preassigned?: { rider: RiderId; vehicle: VehicleId }[]; // Given-clause queue state
};

export type SimEvent =
  | { type: 'ride_request'; rider: RiderId }
  | { type: 'dropoff_complete'; vehicle: VehicleId; rider: RiderId }
  | { type: 'low_battery'; vehicle: VehicleId } // fired ONCE when battery crosses below 15 (world rule)
  | { type: 'idle'; vehicle: VehicleId };

export type PolicyAction =
  | { act: 'assign'; vehicle: VehicleId; rider: RiderId } // append rider to vehicle queue
  | { act: 'reassign'; rider: RiderId; to: VehicleId } // remove from current queue, append to `to`
  | { act: 'reposition'; vehicle: VehicleId; to: LandmarkName }
  | { act: 'charge'; vehicle: VehicleId } // go to Depot / Charging; battery→100 on arrival
  | { act: 'noop' };

export type WorldView = {
  // read-only snapshot handed to the policy at each event
  timeMin: number;
  vehicles: {
    id: VehicleId;
    at: LandmarkName;
    battery: number;
    queue: RiderId[];
    carrying: RiderId | null;
  }[];
  riders: {
    id: RiderId;
    pickup: LandmarkName;
    dropoff: LandmarkName;
    requested: boolean;
    pickedUpBy: VehicleId | null;
    droppedAt: LandmarkName | null;
  }[];
};

export type EndState = {
  riders: {
    id: RiderId;
    servedBy: VehicleId | null;
    droppedAt: LandmarkName | null;
    pickupOrder: number | null; // 0-based global order
  }[];
  vehicles: { id: VehicleId; at: LandmarkName; battery: number; charged: boolean }[];
  log: string[]; // human-readable event/action trace
  completed: boolean; // false when maxSteps guard tripped
};

export type PolicyFn = (world: WorldView, event: SimEvent) => PolicyAction[];

type SimModule = { runScenario: (setup: ScenarioSetup, policy: PolicyFn) => EndState };

// One-time CommonJS-shim evaluation of the trusted sim string (see the
// security boundary note above). Fails loudly at module load if the string
// stops exporting what it promises — a build-time surface, not a runtime one.
const moduleObj: { exports: Partial<SimModule> } = { exports: {} };
new Function('module', 'exports', SIM_JS)(moduleObj, moduleObj.exports);
if (typeof moduleObj.exports.runScenario !== 'function') {
  throw new Error('SIM_JS did not export runScenario — sim source is corrupted');
}
const sim = moduleObj.exports as SimModule;

/**
 * Run one scenario under a TRUSTED policy, in-process. The only validation
 * here is that `policy` is callable — everything the policy RETURNS is
 * validated action-by-action inside the sim (illegal actions are ignored with
 * a log line; exceptions are caught per-event), because wrong output is
 * expected graded material, while a non-function "policy" is a caller bug.
 */
export function runScenario(setup: ScenarioSetup, policy: PolicyFn): EndState {
  if (typeof policy !== 'function') {
    throw new TypeError('runScenario: policy must be a function (world, event) => PolicyAction[]');
  }
  return sim.runScenario(setup, policy);
}

// SINGLE-SOURCE rideshare simulator, carried as a string of plain JavaScript.
//
// Why a string: the exact same sim code must run in two places — (1) evaluated
// in-process by lib/sim/harness.ts for unit tests and the deterministic grader
// backend, and (2) concatenated ahead of an LLM-generated dispatch policy into
// a sandboxed child-process script (lib/sim/sandbox.ts, Task B2-2). A string
// is the only representation that serves both without a build step.
//
// SECURITY BOUNDARY (plan Global Constraints): this string is TRUSTED,
// researcher-owned code. Evaluating it in-process (harness.ts) is safe ONLY
// because of that trust; untrusted (LLM-generated) policy source is NEVER
// evaluated in the server process — it runs exclusively inside the B2-2
// sandbox child process, where this string travels alongside it as data.
//
// Constraints on the string's contents (enforced by sim.test.ts):
//  - plain JavaScript only: no TypeScript syntax; JSDoc comments carry types
//  - zero module loads — the sandbox script must be self-contained
//  - no backticks and no dollar-brace sequences: the carrier template literal
//    would swallow them, so sim code uses string concatenation exclusively
//  - deterministic: no Date.now, no Math.random, no environment reads
//  - CommonJS-style export (module.exports) so both `new Function('module',
//    'exports', SIM_JS)` and `node -e` can consume it unchanged.

export const SIM_JS: string = `'use strict';

/**
 * Deterministic rideshare dispatch simulator — WORLD RULES (researcher-owned).
 *
 * The world is fixed and non-negotiable; what varies is the dispatch POLICY
 * under test. Rules (each implemented and doc-commented below):
 *  - five landmarks on the authored city map (1-decimal coordinates)
 *  - travel time = Manhattan distance at 1 unit/min, rounded UP to whole
 *    minutes; battery drains 1% per distance unit (float), floored at 0.
 *    0% NEVER strands a vehicle — battery is graded SIGNAL, not a movement
 *    constraint (stranding would entangle "wrong policy" with "world deadlocks
 *    the run" and kill the naive baseline's S3 end state)
 *  - low_battery fires ONCE when a drain crosses below 15% (edge-triggered:
 *    a recharge above the threshold re-arms it)
 *  - vehicles serve their queue FIFO, one passenger at a time: when idle with
 *    a non-empty queue, drive to the head rider's pickup, then their dropoff
 *  - pending entries process in (time, insertion-seq) order — fully
 *    deterministic, no clock, no randomness
 *  - the policy is consulted on every SimEvent; illegal actions are IGNORED
 *    with a log line and policy exceptions are caught per-event and treated
 *    as noop (participant policies are wrong in exactly these ways, and that
 *    wrongness is the signal being graded — the sim itself never throws)
 *  - hard cap of 500 processed steps; tripping it returns completed:false.
 *
 * Types mirror lib/sim/harness.ts:
 * @typedef {{ scenarioIdx: number,
 *             vehicles: { id: string, start: string, battery: number }[],
 *             riders: { id: string, pickup: string, dropoff: string, requestAtMin: number }[],
 *             preassigned: { rider: string, vehicle: string }[] | undefined }} ScenarioSetup
 * @typedef {{ type: string, rider: string|undefined, vehicle: string|undefined }} SimEvent
 * @typedef {(world: object, event: SimEvent) => object[]} PolicyFn
 */

var LANDMARKS = {
  'Depot / Charging': { x: 5.4, y: 8 },
  'Newman Library': { x: 5.4, y: 14 },
  'Lane Field': { x: 16.5, y: 11.7 },
  'Executive Airport': { x: 16.4, y: 4 },
  'ASCEND³': { x: 12.4, y: 11.7 },
};

var DEPOT = 'Depot / Charging';
var LOW_BATTERY_THRESHOLD = 15;
var MAX_STEPS = 500;

function isLandmark(name) {
  // hasOwnProperty guard: a policy-supplied name like '__proto__' must not
  // resolve through the prototype chain into a fake landmark.
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(LANDMARKS, name);
}

/**
 * Manhattan distance between two landmarks, in map units. The raw float sum is
 * rounded to 0.1 because the authored coordinates are 1-decimal fixed-point:
 * without it, IEEE noise (16.4 - 5.4 === 11.000000000000002) would leak into
 * ceil() and turn the authored 21-unit Airport→Library leg into 22 minutes.
 */
function manhattan(from, to) {
  var a = LANDMARKS[from];
  var b = LANDMARKS[to];
  var raw = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  return Math.round(raw * 10) / 10;
}

/** JSON.stringify that never throws (hostile action objects may be circular). */
function safeJson(value) {
  try {
    var s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch (err) {
    return '[unserializable value]';
  }
}

/**
 * Run one scenario under one policy to completion (or the step cap).
 * @param {ScenarioSetup} setup
 * @param {PolicyFn} policy
 * @returns {object} EndState — see lib/sim/harness.ts
 */
function runScenario(setup, policy) {
  // Deep-copy the setup into mutable state: fixtures are shared module-level
  // objects reused across runs (the determinism golden test depends on the
  // sim never mutating its input).
  var vehicles = setup.vehicles.map(function (v) {
    return {
      id: v.id,
      at: v.start,
      battery: v.battery,
      queue: [], // rider ids awaiting pickup, FIFO
      carrying: null, // rider id on board (one passenger at a time)
      job: null, // in-flight leg: { kind, riderId, dest, dist } or null
      charged: false, // true once a charge action has completed
    };
  });
  var riders = setup.riders.map(function (r) {
    return {
      id: r.id,
      pickup: r.pickup,
      dropoff: r.dropoff,
      requestAtMin: r.requestAtMin,
      requested: false,
      pickedUpBy: null,
      servedBy: null,
      droppedAt: null,
      pickupOrder: null,
    };
  });
  // Given-clause queue state: preassigned riders start already queued, in
  // fixture order. Their ride_request events still fire at requestAtMin.
  (setup.preassigned || []).forEach(function (p) {
    var v = vehicleById(p.vehicle);
    var r = riderById(p.rider);
    if (v && r) v.queue.push(r.id);
  });

  var log = [];
  // Pending entries: policy-visible 'event's, internal 'arrive' completions,
  // and internal 'dispatch' re-checks. A single (time, seq) order across all
  // three is what makes the run deterministic AND gives the policy its chance
  // to react to every same-minute event BEFORE the world auto-dispatches the
  // next FIFO leg (dispatch entries are enqueued after the events an arrival
  // emits — e.g. in scenario 4 the policy sees low_battery and can shed +
  // charge V1 before V1 would depart for B's pickup).
  var pending = [];
  var seq = 0;
  var now = 0;
  var pickupCounter = 0; // global 0-based pickup order
  var completed = true;

  function vehicleById(id) {
    for (var i = 0; i < vehicles.length; i++) if (vehicles[i].id === id) return vehicles[i];
    return null;
  }
  function riderById(id) {
    for (var i = 0; i < riders.length; i++) if (riders[i].id === id) return riders[i];
    return null;
  }
  /** The vehicle whose queue currently holds this rider, if any. */
  function queueOf(riderId) {
    for (var i = 0; i < vehicles.length; i++) {
      if (vehicles[i].queue.indexOf(riderId) !== -1) return vehicles[i];
    }
    return null;
  }
  function push(time, entry) {
    entry.time = time;
    entry.seq = seq++;
    pending.push(entry);
  }
  function popNext() {
    var best = 0;
    for (var i = 1; i < pending.length; i++) {
      var a = pending[i];
      var b = pending[best];
      if (a.time < b.time || (a.time === b.time && a.seq < b.seq)) best = i;
    }
    return pending.splice(best, 1)[0];
  }
  function fmtBattery(b) {
    // Display-rounded to 0.1 — EndState carries the raw float; the log is for
    // humans (and the battery-trace golden test, which parses these lines).
    return Math.round(b * 10) / 10 + '%';
  }
  function line(text) {
    log.push('[t=' + now + '] ' + text);
  }
  function illegal(reason, action) {
    // World rule: illegal actions never throw — they are ignored WITH a log
    // line, because a participant policy being wrong in exactly this way is
    // the signal the graders exist to capture.
    line('ignored illegal action (' + reason + '): ' + safeJson(action));
  }

  /** Read-only snapshot handed to the policy — fresh copies every consult, so
   *  a policy mutating its view cannot corrupt sim state. */
  function snapshot() {
    return {
      timeMin: now,
      vehicles: vehicles.map(function (v) {
        return { id: v.id, at: v.at, battery: v.battery, queue: v.queue.slice(), carrying: v.carrying };
      }),
      riders: riders.map(function (r) {
        return {
          id: r.id,
          pickup: r.pickup,
          dropoff: r.dropoff,
          requested: r.requested,
          pickedUpBy: r.pickedUpBy,
          droppedAt: r.droppedAt,
        };
      }),
    };
  }

  /** Start a driving leg. kind: 'pickup' | 'dropoff' | 'reposition' | 'charge'. */
  function startLeg(vehicle, kind, dest, riderId) {
    var dist = manhattan(vehicle.at, dest);
    var minutes = Math.ceil(dist); // travel time rule: ceil(Manhattan) at 1 unit/min
    vehicle.job = { kind: kind, riderId: riderId || null, dest: dest, dist: dist };
    line(
      vehicle.id + ' departed ' + vehicle.at + ' for ' + dest +
      ' (' + kind + (riderId ? ' ' + riderId : '') + ', ' + minutes + ' min)'
    );
    push(now + minutes, { kind: 'arrive', vehicleId: vehicle.id });
  }

  function applyAction(action) {
    if (!action || typeof action !== 'object' || typeof action.act !== 'string') {
      illegal('malformed action', action);
      return;
    }
    if (action.act === 'noop') return;

    if (action.act === 'assign') {
      var av = vehicleById(action.vehicle);
      var ar = riderById(action.rider);
      if (!av || !ar) { illegal('unknown vehicle or rider id', action); return; }
      if (ar.pickedUpBy !== null) { illegal('rider ' + ar.id + ' already picked up or served', action); return; }
      if (queueOf(ar.id)) { illegal('rider ' + ar.id + ' is already assigned', action); return; }
      av.queue.push(ar.id);
      line(ar.id + ' assigned to ' + av.id + ' (queue: ' + av.queue.join(',') + ')');
      return;
    }

    if (action.act === 'reassign') {
      var rr = riderById(action.rider);
      var tv = vehicleById(action.to);
      if (!rr || !tv) { illegal('unknown vehicle or rider id', action); return; }
      if (rr.pickedUpBy !== null) { illegal('reassign of a picked-up rider', action); return; }
      var fromV = queueOf(rr.id);
      if (!fromV) { illegal('rider ' + rr.id + ' is not assigned to any vehicle', action); return; }
      fromV.queue.splice(fromV.queue.indexOf(rr.id), 1);
      tv.queue.push(rr.id);
      line(rr.id + ' reassigned from ' + fromV.id + ' to ' + tv.id);
      return;
    }

    if (action.act === 'reposition') {
      var pv = vehicleById(action.vehicle);
      if (!pv) { illegal('unknown vehicle id', action); return; }
      if (!isLandmark(action.to)) { illegal('unknown landmark', action); return; }
      if (pv.carrying !== null) { illegal('reposition of a vehicle carrying a passenger', action); return; }
      if (pv.job) { illegal('reposition of a vehicle that is mid-leg', action); return; }
      if (pv.at === action.to) {
        // Livelock guard: a zero-length reposition would complete instantly,
        // fire idle, and let an "always reposition here" policy spin to the
        // step cap. Treated as a logged noop instead.
        line(pv.id + ' reposition to ' + action.to + ' skipped — already there');
        return;
      }
      startLeg(pv, 'reposition', action.to, null);
      return;
    }

    if (action.act === 'charge') {
      var cv = vehicleById(action.vehicle);
      if (!cv) { illegal('unknown vehicle id', action); return; }
      if (cv.carrying !== null) { illegal('charge of a vehicle carrying a passenger', action); return; }
      if (cv.job) { illegal('charge of a vehicle that is mid-leg', action); return; }
      if (cv.at === DEPOT) {
        // Already at the charger: instantaneous, no leg, no event (the policy
        // is next consulted on whatever event follows naturally).
        cv.battery = 100;
        cv.charged = true;
        line(cv.id + ' charged to 100% at ' + DEPOT);
        return;
      }
      startLeg(cv, 'charge', DEPOT, null);
      return;
    }

    illegal('unknown act "' + action.act + '"', action);
  }

  function describeEvent(ev) {
    if (ev.type === 'ride_request') return 'ride_request ' + ev.rider;
    if (ev.type === 'dropoff_complete') return 'dropoff_complete ' + ev.vehicle + ' ' + ev.rider;
    if (ev.type === 'low_battery') return 'low_battery ' + ev.vehicle;
    return 'idle ' + ev.vehicle;
  }

  /** Consult the policy on one SimEvent, apply its actions, then queue FIFO
   *  dispatch re-checks for any vehicle the actions gave startable work. */
  function consult(ev) {
    line('event: ' + describeEvent(ev));
    if (ev.type === 'ride_request') {
      var reqR = riderById(ev.rider);
      if (reqR) reqR.requested = true;
    }
    var actions;
    try {
      actions = policy(snapshot(), ev);
    } catch (err) {
      // Policy exceptions are per-event noops with a log line — never fatal.
      line('policy exception on ' + ev.type + ' — treated as noop: ' + (err && err.message ? err.message : String(err)));
      actions = [];
    }
    if (!Array.isArray(actions)) {
      line('policy returned a non-array on ' + ev.type + ' — treated as noop: ' + safeJson(actions));
      actions = [];
    }
    for (var i = 0; i < actions.length; i++) applyAction(actions[i]);
    // Deferred dispatch: never start FIFO legs synchronously here. Enqueueing
    // a dispatch entry (same minute, later seq) guarantees every other event
    // already queued for this minute is consulted first.
    vehicles.forEach(function (v) {
      if (!v.job && v.carrying === null && v.queue.length > 0) {
        var head = riderById(v.queue[0]);
        if (head && head.requested) push(now, { kind: 'dispatch', vehicleId: v.id });
      }
    });
  }

  /** A vehicle finished a leg: apply drain, complete the job, emit events. */
  function arrive(entry) {
    var v = vehicleById(entry.vehicleId);
    if (!v || !v.job) return; // defensive: legs are never cancelled, so this should not happen
    var job = v.job;
    v.job = null;

    var crossed = false;
    if (job.dist > 0) {
      // Battery rule: 1% per unit, floored at 0. low_battery is edge-triggered
      // on this drain crossing below the threshold — applied at arrival because
      // movement is atomic (vehicles exist only at landmarks).
      var before = v.battery;
      v.battery = Math.max(0, before - job.dist);
      crossed = before >= LOW_BATTERY_THRESHOLD && v.battery < LOW_BATTERY_THRESHOLD;
    }
    v.at = job.dest;
    line(v.id + ' arrived at ' + job.dest + ' (battery ' + fmtBattery(v.battery) + ')');

    if (job.kind === 'pickup') {
      var pr = riderById(job.riderId);
      var qi = v.queue.indexOf(job.riderId);
      if (pr && qi !== -1 && pr.pickedUpBy === null) {
        v.queue.splice(qi, 1);
        v.carrying = pr.id;
        pr.pickedUpBy = v.id;
        pr.servedBy = v.id;
        pr.pickupOrder = pickupCounter++;
        line(v.id + ' picked up ' + pr.id + ' at ' + v.at);
        startLeg(v, 'dropoff', pr.dropoff, pr.id); // FIFO rule: pickup rolls straight into dropoff
      } else {
        // The rider was reassigned away while this vehicle was en route.
        line(v.id + ' pickup of ' + job.riderId + ' aborted — rider no longer queued here');
      }
    } else if (job.kind === 'dropoff') {
      var dr = riderById(job.riderId);
      v.carrying = null;
      if (dr) {
        dr.droppedAt = job.dest;
        line(v.id + ' dropped off ' + dr.id + ' at ' + job.dest);
        push(now, { kind: 'event', ev: { type: 'dropoff_complete', vehicle: v.id, rider: dr.id } });
      }
    } else if (job.kind === 'charge') {
      v.battery = 100;
      v.charged = true;
      // Suppress a threshold crossing consumed by this very charge: the
      // vehicle is never observable TO THE POLICY below 15% (it recharges the
      // same minute it arrives; the arrival LOG line may still print the
      // sub-threshold value), so firing low_battery here would be noise.
      crossed = false;
      line(v.id + ' charged to 100% at ' + DEPOT);
    }
    // (reposition needs nothing beyond the arrival itself)

    // Emission order matters and is a world rule: low_battery fires AFTER the
    // dropoff_complete of the leg that drained it (matches the authored
    // scenario-4 When), and the dispatch re-check comes last so the policy
    // sees both before the world starts the next FIFO leg.
    if (crossed) push(now, { kind: 'event', ev: { type: 'low_battery', vehicle: v.id } });
    if (!v.job) push(now, { kind: 'dispatch', vehicleId: v.id });
  }

  /** Re-check one vehicle: start its next FIFO leg, or report it idle. */
  function dispatch(entry) {
    var v = vehicleById(entry.vehicleId);
    if (!v || v.job || v.carrying !== null) return; // became busy since this was queued
    if (v.queue.length > 0) {
      var head = riderById(v.queue[0]);
      // A queued rider who has not yet requested gates the vehicle in place;
      // the ride_request consult re-queues a dispatch when it fires.
      if (head && head.requested) startLeg(v, 'pickup', head.pickup, head.id);
    } else {
      // Truly idle (no job, no queue) — a policy-visible transition.
      push(now, { kind: 'event', ev: { type: 'idle', vehicle: v.id } });
    }
  }

  // Seed the run: every rider's ride_request at its authored minute (fixture
  // order), then one dispatch per vehicle at t=0 (vehicle order). Same-minute
  // seq order makes t=0 requests visible before the t=0 dispatches — a
  // preassigned rider at the vehicle's own landmark is picked up immediately.
  riders.forEach(function (r) {
    push(r.requestAtMin, { kind: 'event', ev: { type: 'ride_request', rider: r.id } });
  });
  vehicles.forEach(function (v) {
    push(0, { kind: 'dispatch', vehicleId: v.id });
  });

  var steps = 0;
  while (pending.length > 0) {
    if (steps >= MAX_STEPS) {
      // Hard cap: a policy that manufactures endless work (e.g. a reposition
      // ping-pong) terminates with an honest completed:false.
      completed = false;
      line('step cap (' + MAX_STEPS + ') reached — aborting run');
      break;
    }
    steps++;
    var entry = popNext();
    now = entry.time;
    if (entry.kind === 'event') consult(entry.ev);
    else if (entry.kind === 'arrive') arrive(entry);
    else dispatch(entry);
  }

  return {
    riders: riders.map(function (r) {
      return { id: r.id, servedBy: r.servedBy, droppedAt: r.droppedAt, pickupOrder: r.pickupOrder };
    }),
    vehicles: vehicles.map(function (v) {
      return { id: v.id, at: v.at, battery: v.battery, charged: v.charged };
    }),
    log: log,
    completed: completed,
  };
}

module.exports = { runScenario };
`;

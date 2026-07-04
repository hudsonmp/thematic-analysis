// PURE progression engine over study_snapshots rows (no I/O). Encodes the data
// realities verified against the live study DB (see the viewer design spec §2):
//   - duplicate rows exist (3 users re-flushed slots) → dedupe LATEST per
//     (phase, scenarioIdx) by clientTs (createdAt fallback);
//   - clientTs is NOT monotonic across slots for one user → order by SLOT
//     ordinal (scenario_idx), never by wall clock;
//   - `final` is a byte-identical flush of the last scenario (26/26 users) →
//     it is NOT a 6th step; it sets `submitted` on the Scenario 4 step;
//   - completeness is a monotone prefix (truncated tails) → absent steps are
//     null snapshots, an expected state;
//   - entity/element names are RAW user input (trailing spaces) → diffs match
//     on TRIMMED names so whitespace never reads as change.

import type { Entity } from '@/lib/spec/reconstruct';

export type PhaseSnapshot = {
  phase: 'initial' | 'after_scenario' | 'final';
  scenarioIdx: number | null;
  spec: string;
  entities: Entity[];
  clientTs: string | null;
  createdAt: string;
};

export type EntityChange = { name: string; addedElements: string[]; removedElements: string[] };
export type EntityDiff = {
  addedEntities: string[];
  removedEntities: string[];
  changedEntities: EntityChange[];
};

export type ProgressionStep = {
  ordinal: 0 | 1 | 2 | 3 | 4;
  kind: 'requirement' | 'scenario';
  label: string;
  scenarioIdx: number | null;
  snapshot: PhaseSnapshot | null;
  submitted: boolean;
  diff: EntityDiff | null;
};

/** Slot ordinal for ordering/keying: initial=0, after_scenario n=1+n, final=5.
 *  Returns null for a row that fits no slot (defensive: unknown phase or an
 *  after_scenario row with no scenarioIdx — dropped by orderSnapshots). */
function slotOrdinal(row: PhaseSnapshot): number | null {
  if (row.phase === 'initial') return 0;
  if (row.phase === 'final') return 5;
  if (row.phase === 'after_scenario' && row.scenarioIdx !== null && row.scenarioIdx >= 0 && row.scenarioIdx <= 3) {
    return 1 + row.scenarioIdx;
  }
  return null;
}

/** Epoch ms of the row's commit instant: clientTs, falling back to createdAt.
 *  Unparseable → -Infinity (any parseable row wins the dedupe). */
function commitMs(row: PhaseSnapshot): number {
  const t = Date.parse(row.clientTs ?? row.createdAt);
  return Number.isNaN(t) ? -Infinity : t;
}

/** Dedupe to the LATEST row per slot, then order by slot ordinal. Rows fitting
 *  no slot are dropped. */
export function orderSnapshots(rows: PhaseSnapshot[]): PhaseSnapshot[] {
  const bySlot = new Map<number, PhaseSnapshot>();
  for (const row of rows) {
    const slot = slotOrdinal(row);
    if (slot === null) continue;
    const existing = bySlot.get(slot);
    if (!existing || commitMs(row) >= commitMs(existing)) bySlot.set(slot, row);
  }
  return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}

/** # of the FIVE step slots (ordinals 0–4) present after dedupe. `final` is not
 *  a step slot, so it never counts. Drives the picker's "n/5" hint. */
export function stepCount(rows: PhaseSnapshot[]): number {
  const slots = new Set<number>();
  for (const row of rows) {
    const slot = slotOrdinal(row);
    if (slot !== null && slot <= 4) slots.add(slot);
  }
  return slots.size;
}

const STEP_DEFS: { ordinal: 0 | 1 | 2 | 3 | 4; kind: 'requirement' | 'scenario'; label: string; scenarioIdx: number | null }[] = [
  { ordinal: 0, kind: 'requirement', label: 'Requirement', scenarioIdx: null },
  { ordinal: 1, kind: 'scenario', label: 'Scenario 1', scenarioIdx: 0 },
  { ordinal: 2, kind: 'scenario', label: 'Scenario 2', scenarioIdx: 1 },
  { ordinal: 3, kind: 'scenario', label: 'Scenario 3', scenarioIdx: 2 },
  { ordinal: 4, kind: 'scenario', label: 'Scenario 4', scenarioIdx: 3 },
];

/** Build the 5 display steps from raw rows (dedupes + orders internally).
 *  `submitted` marks the Scenario 4 step when a `final` row exists. Each step's
 *  `diff` compares its entities to the PREVIOUS NON-NULL step's, so a missing
 *  middle slot doesn't blank the next step's diff. */
export function buildSteps(rows: PhaseSnapshot[]): ProgressionStep[] {
  const ordered = orderSnapshots(rows);
  const bySlot = new Map<number, PhaseSnapshot>();
  for (const row of ordered) {
    const slot = slotOrdinal(row);
    if (slot !== null) bySlot.set(slot, row);
  }
  const hasFinal = bySlot.has(5);

  const steps: ProgressionStep[] = [];
  let prev: PhaseSnapshot | null = null;
  for (const def of STEP_DEFS) {
    const snapshot = bySlot.get(def.ordinal) ?? null;
    const diff = snapshot && prev ? diffEntities(prev.entities, snapshot.entities) : null;
    steps.push({
      ...def,
      snapshot,
      submitted: def.ordinal === 4 && snapshot !== null && hasFinal,
      diff,
    });
    if (snapshot) prev = snapshot;
  }
  return steps;
}

/** Entity/element set diff, matched by TRIMMED name (case-sensitive). Entities
 *  whose trimmed name is empty are unmatchable and ignored. Duplicate trimmed
 *  names: first occurrence wins (raw user data; documented, not an error). */
export function diffEntities(prev: Entity[], curr: Entity[]): EntityDiff {
  const prevMap = byTrimmedName(prev);
  const currMap = byTrimmedName(curr);

  const addedEntities: string[] = [];
  const removedEntities: string[] = [];
  const changedEntities: EntityChange[] = [];

  for (const name of currMap.keys()) {
    if (!prevMap.has(name)) addedEntities.push(name);
  }
  for (const name of prevMap.keys()) {
    if (!currMap.has(name)) removedEntities.push(name);
  }
  for (const [name, currEnt] of currMap) {
    const prevEnt = prevMap.get(name);
    if (!prevEnt) continue;
    const prevEls = elementNameSet(prevEnt);
    const currEls = elementNameSet(currEnt);
    const addedElements = [...currEls].filter((e) => !prevEls.has(e));
    const removedElements = [...prevEls].filter((e) => !currEls.has(e));
    if (addedElements.length > 0 || removedElements.length > 0) {
      changedEntities.push({ name, addedElements, removedElements });
    }
  }
  return { addedEntities, removedEntities, changedEntities };
}

function byTrimmedName(entities: Entity[]): Map<string, Entity> {
  const map = new Map<string, Entity>();
  for (const ent of entities) {
    const name = ent.name.trim();
    if (!name || map.has(name)) continue;
    map.set(name, ent);
  }
  return map;
}

function elementNameSet(ent: Entity): Set<string> {
  const set = new Set<string>();
  for (const el of ent.elements) {
    const name = el.name.trim();
    if (name) set.add(name);
  }
  return set;
}

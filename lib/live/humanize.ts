// ---------------------------------------------------------------------------
// Live-event humanizer — Task 3 of the live co-observation feature.
//
// A study_events row is a machine record: an `event_type` plus a free-form JSON
// `payload` and a `module_id`. The live "current step" indicator needs a SHORT,
// human-readable gloss of "what the participant is doing right now" so a
// co-observer reads it at a glance, without parsing JSON. `humanizeEvent` is the
// pure mapping from one event to that label.
//
// It is deliberately a PURE function (no I/O, no DB) so it is unit-testable and
// can run on either the server (in the poll action) or the client. It never
// throws: an unknown event type or a malformed payload degrades to a readable
// fallback rather than crashing the live view.
//
// The study tables are read-only; this module only READS the event shape, never
// writes. See app/actions/live.ts for the (also read-only) data layer.
// ---------------------------------------------------------------------------

/** The minimal event shape the humanizer reads (a `study_events` row's display
 *  fields). `payload` is the raw JSON column — `unknown` because its shape
 *  varies by `event_type` and we narrow defensively inside each branch. */
export type HumanizableEvent = {
  eventType: string;
  payload: unknown;
  moduleId: string;
};

/** Per-module metadata used to resolve a `module_start` event to a readable
 *  module name. Keyed by the study module id (`study_events.module_id`). The
 *  live view builds this from the active study's authored modules; when absent
 *  (or the id is unknown), `module_start` falls back to the payload's
 *  `moduleType` or a generic label. */
export type ModuleMeta = { id: string; type: string; title: string };

/**
 * Render one study event as a short, human-readable "current step" label.
 *
 * Mapping (the event types the study actually emits — see study_events):
 *   - `module_start`     → "entered <module>" (module name from `modulesMeta`,
 *                          else the payload's `moduleType`, else the module id)
 *   - `step_advance`     → the destination step, humanized from the payload's
 *                          `to` (e.g. "scenario_2_revise" → "Scenario 2 · revise")
 *   - `spec_edit`        → "editing specification"
 *   - `entities_edit`    → "editing entities"
 *   - `map_vehicle_move` → "moved a vehicle"
 *   - `map_marker_*`     → "map marker" (add/relabel/move/remove all collapse)
 *   - `retro_submit`     → "submitted retrospective"
 *   - `study_complete`   → "finished"
 *   - anything else      → a readable spacing of the raw type (the fallback)
 *
 * `modulesMeta` is optional and only consulted for `module_start`. Pass the
 * active study's modules to get titles like "entered Rideshare Matching
 * Platform"; omit it and the label degrades to the payload's `moduleType`.
 */
export function humanizeEvent(
  event: HumanizableEvent,
  modulesMeta?: ModuleMeta[],
): string {
  const payload = asRecord(event.payload);

  switch (event.eventType) {
    case 'module_start': {
      const name = moduleName(event.moduleId, payload, modulesMeta);
      return name ? `entered ${name}` : 'entered a module';
    }
    case 'step_advance': {
      const to = typeof payload.to === 'string' ? payload.to : null;
      const label = to ? humanizeStep(to) : null;
      return label ?? 'advanced a step';
    }
    case 'spec_edit':
      return 'editing specification';
    case 'entities_edit':
      return 'editing entities';
    case 'scratchpad_edit':
      return 'editing scratchpad';
    case 'warmup_answer_edit':
      return 'editing warmup answer';
    case 'map_vehicle_move':
      return 'moved a vehicle';
    // All marker edits (add / relabel / move / remove) collapse to one label —
    // the co-observer only needs "they're working on the map", not the verb.
    case 'map_marker_add':
    case 'map_marker_relabel':
    case 'map_marker_move':
    case 'map_marker_remove':
      return 'map marker';
    case 'retro_submit':
      return 'submitted retrospective';
    case 'study_complete':
      return 'finished';
    default:
      // Unknown / unhandled type: render the raw event_type readably
      // (snake_case → spaced words) rather than crashing or showing JSON.
      return prettifyType(event.eventType);
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Coerce an unknown payload to a string-keyed record for safe field access.
 *  Non-objects (null, arrays, primitives) yield an empty record so every
 *  `payload.x` read is a safe `undefined` rather than a throw. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Humanize a `step_advance` destination step key into a readable phrase.
 *
 * The study emits step keys like:
 *   - `scenario_2_revise`     → "Scenario 2 · revise"
 *   - `scenario_3_retro_0`    → "Scenario 3 · retro 1"   (retro index is 0-based)
 *   - `retro_1`               → "Retrospective 2"        (final retro report)
 *   - `initial_spec` / `read` → "Initial spec" / "Read"  (generic fallback)
 *
 * Anything that doesn't match a known shape is spaced/capitalized generically.
 */
/** 1-based integer → Roman numeral. Scenario indices in the step keys are
 *  0-based (`scenario_0_…` is the first), so callers pass `idx + 1`: the first
 *  scenario reads as "I", not "0". */
function toRoman(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'],
    [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'],
    [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [v, sym] of table) while (n >= v) { out += sym; n -= v; }
  return out;
}

function humanizeStep(step: string): string {
  // scenario_<n>_retro_<m>  → "Scenario <I-based roman> · retro <m+1>"
  const scenarioRetro = step.match(/^scenario_(\d+)_retro_(\d+)$/);
  if (scenarioRetro) {
    const n = toRoman(Number(scenarioRetro[1]) + 1);
    const m = Number(scenarioRetro[2]) + 1;
    return `Scenario ${n} · retro ${m}`;
  }

  // scenario_<n>_<phase>  → "Scenario <I-based roman> · <phase>"  (read/ponder/revise)
  const scenarioPhase = step.match(/^scenario_(\d+)_(.+)$/);
  if (scenarioPhase) {
    const n = toRoman(Number(scenarioPhase[1]) + 1);
    const phase = scenarioPhase[2].replace(/_/g, ' ');
    return `Scenario ${n} · ${phase}`;
  }

  // retro_<n>  → "Retrospective <n+1>"  (the standalone retrospective report)
  const retro = step.match(/^retro_(\d+)$/);
  if (retro) {
    return `Retrospective ${Number(retro[1]) + 1}`;
  }

  // Generic: snake_case → "Sentence case".
  return capitalize(step.replace(/_/g, ' '));
}

/**
 * Resolve a readable module name for a `module_start` event. Prefers the
 * authored module TITLE (from `modulesMeta`, matched on `module_id`); falls back
 * to a readable form of the payload's `moduleType`; finally to null (the caller
 * renders "entered a module").
 */
function moduleName(
  moduleId: string,
  payload: Record<string, unknown>,
  modulesMeta?: ModuleMeta[],
): string | null {
  const meta = modulesMeta?.find((m) => m.id === moduleId);
  if (meta?.title && meta.title.trim()) return meta.title.trim();

  const moduleType = payload.moduleType;
  if (typeof moduleType === 'string' && moduleType.trim()) {
    return capitalize(moduleType.replace(/_/g, ' '));
  }
  return null;
}

/** snake_case event_type → "spaced words" (the unknown-type fallback). */
function prettifyType(eventType: string): string {
  const spaced = (eventType ?? '').replace(/_/g, ' ').trim();
  return spaced || 'activity';
}

/** Capitalize the first character of a string; leaves the rest untouched. */
function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Auto-derive episode marks from the participant event stream — Task 4 of the
// live co-observation feature.
//
// The participant's `study_events` carry the structural boundaries of the task
// session: a `module_start` (entering the recorded task module) and a sequence of
// `step_advance` events ({from, to} step payloads) as they move through
// requirements analysis, writing the specification, reading each new scenario,
// editing the specification, and the per-scenario + general retrospectives. Those
// boundaries are EXACTLY the "episodes" the researcher would otherwise mark by hand
// while scrubbing the video. This module derives them PROGRAMMATICALLY from the
// event log so they materialize onto the recording timeline automatically (see
// app/actions/episodes.ts:materializeAutoEpisodes).
//
// The canonical phase vocabulary is chosen to map 1:1 onto the researcher's EIGHT
// existing `cb_episodes` presets ("Requirements Analysis", "Writing Specification
// from Requirements", "New Scenario Introduced", "Editing Specification",
// "Scenario Retrospective", and the three "General Retrospective Question I/II/III")
// so materialization REUSES those presets rather than auto-creating duplicates.
//
// PURE + side-effect-free (no I/O, no DB, no `server-only`) so it is unit-testable
// and runs the same on server or client. It only READS the event shape; the study
// tables are never written.
// ---------------------------------------------------------------------------

/** The canonical, recording-timeline episode phases. The derivation collapses the
 *  study's fine-grained step keys (e.g. `scenario_2_revise`, `scenario_0_retro_1`)
 *  onto this small vocabulary; each value maps 1:1 to one of the researcher's eight
 *  `cb_episodes` presets by NAME at materialization time (see
 *  app/actions/episodes.ts:CANONICAL_EPISODE_NAME). */
export type CanonicalStep =
  | 'requirements'        // module entry / intro  → "Requirements Analysis"
  | 'specification'       // initial_spec          → "Writing Specification from Requirements"
  | 'scenario'            // scenario_<n>_read     → "New Scenario Introduced"
  | 'editing'             // scenario_<n>_revise   → "Editing Specification"
  | 'scenario_retro'      // scenario_<n>_retro_<m>→ "Scenario Retrospective"
  | 'general_retro_1'     // retro_0               → "General Retrospective Question I"
  | 'general_retro_2'     // retro_1               → "General Retrospective Question II"
  | 'general_retro_3';    // retro_2               → "General Retrospective Question III"

/** The minimal `study_events` row shape the derivation reads: the boundary type,
 *  the raw JSON `payload` (narrowed defensively inside), and `created_at` (the
 *  absolute timestamp aligned against the recording anchor). */
export type DerivableEvent = {
  eventType: string;
  payload: unknown;
  /** `study_events.created_at` (ISO-8601 / Postgres timestamptz). */
  createdAt: string;
};

/** One derived episode boundary: the canonical phase entered, and its offset
 *  (ms) into the recording (`created_at − recording_started_at`). */
export type EpisodeMark = {
  stepLabel: CanonicalStep;
  tStartMs: number;
};

/**
 * Derive ordered episode marks from a participant's task `study_events`.
 *
 * For each boundary event (in the order given — the caller passes them ordered by
 * `created_at` ascending):
 *   - `module_start` → the module's first phase, `requirements` (the participant
 *     enters the task at its requirements-analysis step; the study has no explicit
 *     "entered intro" step_advance, so module_start IS that boundary).
 *   - `step_advance` → the canonical phase parsed from the payload's `to` step
 *     (see `canonicalStep`). Non-canonical destinations (e.g. `context`, `done`,
 *     `body`, `scenario_<n>_ponder`, `retro_<m>` for m ≥ 3) yield no mark and are
 *     skipped.
 * Any other event type is ignored.
 *
 * `tStartMs = created_at_ms − recordingStartedAtMs`. Two normalizations, both
 * DOCUMENTED choices:
 *   - CLAMP (not drop): a negative offset (an event a few ms before record start,
 *     common right at the anchor) is clamped to 0 rather than dropped — the
 *     boundary is still meaningful and belongs at the very start of the recording.
 *   - DE-DUP consecutive identical `stepLabel`s: a run of the same canonical phase
 *     (e.g. two `scenario` reads back-to-back across scenarios) collapses to its
 *     first occurrence, so the timeline shows one mark per phase entry. The three
 *     `general_retro_1/2/3` are DISTINCT labels, so the three standalone retros
 *     stay as three marks even when consecutive.
 *
 * Returns the marks in input (chronological) order.
 */
export function deriveEpisodeMarks(
  events: DerivableEvent[],
  recordingStartedAtMs: number,
): EpisodeMark[] {
  const marks: EpisodeMark[] = [];
  let lastLabel: CanonicalStep | null = null;

  for (const event of events) {
    const label = labelForEvent(event);
    if (label === null) continue;

    // De-dup consecutive identical phases.
    if (label === lastLabel) continue;
    lastLabel = label;

    const createdMs = Date.parse(event.createdAt);
    if (Number.isNaN(createdMs)) continue; // unparseable timestamp → skip the mark

    // Clamp negative offsets (pre-record events) to the recording's t=0.
    const tStartMs = Math.max(0, Math.round(createdMs - recordingStartedAtMs));
    marks.push({ stepLabel: label, tStartMs });
  }

  return marks;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Resolve the canonical phase a boundary event ENTERS, or null if the event is
 *  not a phase boundary (or its destination is non-canonical). */
function labelForEvent(event: DerivableEvent): CanonicalStep | null {
  switch (event.eventType) {
    case 'module_start':
      // Entering the task module = the start of requirements analysis.
      return 'requirements';
    case 'step_advance': {
      const to = asRecord(event.payload).to;
      return typeof to === 'string' ? canonicalStep(to) : null;
    }
    default:
      return null;
  }
}

/**
 * Map a study step key onto a `CanonicalStep`, or null if it is not a recognized
 * recording-timeline phase.
 *
 * Mirrors the parsing idiom in lib/live/humanize.ts (regex on the `scenario_…`
 * shape), but collapses to the COARSE phase that matches one of the eight presets:
 *   - `intro`                          → 'requirements'
 *   - `initial_spec` / `initial-spec`  → 'specification'
 *   - `scenario_<n>_read`              → 'scenario'
 *   - `scenario_<n>_revise`            → 'editing'
 *   - `scenario_<n>_ponder`            → null (no preset for ponder; dropped)
 *   - `scenario_<n>_retro_<m>`         → 'scenario_retro'
 *   - `retro_0` / `retro_1` / `retro_2`→ 'general_retro_1' / '…_2' / '…_3'
 *   - `retro_<m>` for m ≥ 3            → null (only three general questions exist)
 *   - anything else (context/done/body/…) → null (dropped)
 */
function canonicalStep(step: string): CanonicalStep | null {
  const s = step.trim().toLowerCase();

  if (s === 'intro') return 'requirements';
  if (s === 'initial_spec' || s === 'initial-spec') return 'specification';

  const scenarioPhase = s.match(/^scenario_\d+_(read|revise)$/);
  if (scenarioPhase) {
    return scenarioPhase[1] === 'read' ? 'scenario' : 'editing';
  }
  // `scenario_<n>_ponder` is a real step but has no preset → dropped.

  // Per-scenario retro (`scenario_2_retro_0`) → the single scenario-retro phase.
  if (/^scenario_\d+_retro_\d+$/.test(s)) return 'scenario_retro';

  // Standalone general retrospectives — only the first three exist as presets.
  const generalRetro = s.match(/^retro_(\d+)$/);
  if (generalRetro) {
    switch (generalRetro[1]) {
      case '0':
        return 'general_retro_1';
      case '1':
        return 'general_retro_2';
      case '2':
        return 'general_retro_3';
      default:
        return null; // retro_3+ → no preset
    }
  }

  return null;
}

/** Coerce an unknown payload to a string-keyed record for safe field access.
 *  Non-objects (null, arrays, primitives) yield an empty record so every
 *  `payload.x` read is a safe `undefined` rather than a throw. Mirrors
 *  lib/live/humanize.ts. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

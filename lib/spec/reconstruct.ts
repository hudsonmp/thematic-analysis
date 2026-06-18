// Pure spec-replay reconstruction: given a participant's evolving spec/entities
// edit streams (each row carrying the FULL value, NOT a diff), reconstruct the
// spec text + entity table as they stood at any absolute instant. No DOM, no I/O,
// no `server-only` — pure and unit-testable, importable anywhere (server action or
// client component). Alignment to the recording clock happens at the call site
// (the caller passes an ABSOLUTE epoch instant `atMs = anchorMs + playheadMs`),
// mirroring lib/chat/align.ts's one-clock discipline.
//
// Resolution is LAST-WRITE-AT-OR-BEFORE-t (≤, inclusive), the snapshot semantics
// of a debounced full-value stream: the participant's screen at instant t showed
// whatever value was last committed at or before t. The two streams resolve
// INDEPENDENTLY — spec and entities debounce separately, so the most-recent spec
// and the most-recent entities at t need not share a row.

// The Entity/Element shapes the participant app's `entities_edit` payloads
// serialize. COPIED from spec-study-app/lib/types/study.ts (that app is the
// source of truth for what gets JSON.stringify'd into the payload); copied
// rather than imported because that package is a separate repo not on this app's
// module graph. Keep these in sync if the participant app's shape changes.
export type Element = { id: string; name: string };
export type Entity = { id: string; name: string; elements: Element[] };

/** One raw edit row as `listSessionSpecTimeline` returns it: the absolute instant
 *  it was committed (`createdAt`, ISO timestamptz) and the FULL serialized value at
 *  that instant. For `specEdits`, `value` is the entire spec string; for
 *  `entityEdits`, `value` is `JSON.stringify(Entity[])`. */
export type SpecEdit = {
  /** study_events.created_at (ISO timestamptz). The timeline key. */
  createdAt: string;
  /** The FULL value at this instant (spec string, or JSON of Entity[]). */
  value: string;
};

/** The two raw edit streams for a session, oldest-first. Alignment is the
 *  caller's job (like chat) — this is the unaligned data the data layer returns. */
export type SpecTimeline = {
  specEdits: SpecEdit[];
  entityEdits: SpecEdit[];
};

/** The reconstructed spec/entities state at a single instant. `spec` is the
 *  last spec value at-or-before t (`''` before the first spec edit); `entities`
 *  is the JSON.parse of the last entities value at-or-before t (`[]` before the
 *  first entities edit, or when that value is malformed / not an Entity[]). */
export type SpecState = {
  spec: string;
  entities: Entity[];
};

/**
 * Reconstruct the spec text + entity table as they stood at the absolute instant
 * `atMs` (ms epoch — the caller passes `anchorMs + playheadMs`). PURE.
 *
 *   - `spec`     = the `value` of the LAST `specEdits` row with
 *                  `Date.parse(createdAt) <= atMs`, else `''`.
 *   - `entities` = `JSON.parse(value)` of the LAST `entityEdits` row with
 *                  `Date.parse(createdAt) <= atMs`, else `[]`. A malformed payload
 *                  (or a parse that isn't an array of entity-shaped objects)
 *                  yields `[]` — this NEVER throws.
 *
 * Boundary is INCLUSIVE (`<=`): an instant exactly on an edit sees that edit. The
 * two streams resolve independently. Rows are NOT assumed sorted here — the
 * latest-≤-t winner is found by scanning, so an out-of-order input still resolves
 * correctly (the data layer returns ascending, but this stays robust).
 */
export function specStateAt(timeline: SpecTimeline, atMs: number): SpecState {
  const specRow = latestAtOrBefore(timeline.specEdits, atMs);
  const entRow = latestAtOrBefore(timeline.entityEdits, atMs);

  return {
    spec: specRow ? specRow.value : '',
    entities: entRow ? parseEntities(entRow.value) : [],
  };
}

/** The edit row with the greatest parseable `createdAt` that is `<= atMs`, or
 *  null if none qualifies. Rows with an unparseable `createdAt` are skipped (a
 *  malformed timestamp can never be the active snapshot). Does NOT assume the
 *  input is sorted. */
function latestAtOrBefore(edits: SpecEdit[], atMs: number): SpecEdit | null {
  let best: SpecEdit | null = null;
  let bestMs = -Infinity;
  for (const edit of edits) {
    const t = Date.parse(edit.createdAt);
    if (Number.isNaN(t)) continue;
    if (t <= atMs && t >= bestMs) {
      best = edit;
      bestMs = t;
    }
  }
  return best;
}

/** Parse an `entities_edit` payload value into `Entity[]`. GUARDED: a malformed
 *  JSON string, or a parse that is not an array of entity-shaped objects, yields
 *  `[]` rather than throwing. Coerces each element defensively so a partially-
 *  malformed entity does not crash the replay. */
function parseEntities(value: string): Entity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(coerceEntity);
}

/** Coerce one parsed value into an Entity, tolerating missing/odd fields. */
function coerceEntity(raw: unknown): Entity {
  if (!raw || typeof raw !== 'object') {
    return { id: '', name: '', elements: [] };
  }
  const rec = raw as Record<string, unknown>;
  const elements = Array.isArray(rec.elements) ? rec.elements.map(coerceElement) : [];
  return {
    id: typeof rec.id === 'string' ? rec.id : '',
    name: typeof rec.name === 'string' ? rec.name : '',
    elements,
  };
}

/** Coerce one parsed value into an Element, tolerating missing/odd fields. */
function coerceElement(raw: unknown): Element {
  if (!raw || typeof raw !== 'object') {
    return { id: '', name: '' };
  }
  const rec = raw as Record<string, unknown>;
  return {
    id: typeof rec.id === 'string' ? rec.id : '',
    name: typeof rec.name === 'string' ? rec.name : '',
  };
}

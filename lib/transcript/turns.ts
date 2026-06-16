// Pure turn-grouping over ordered transcript segments. No DOM, no I/O — safe to
// unit-test and to import from anywhere (server or client). This lets the UI
// render one block per speaker TURN (a maximal run of consecutive same-speaker
// cues) instead of one row per SRT cue: monologues stay together, and the only
// break is a speaker change.

/** The minimal segment shape turn-grouping reads. CloudSegment (app/actions/sessions.ts)
 *  is assignable to this. */
export type TurnSegment = {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
};

/** A maximal run of consecutive same-speaker segments. */
export type Turn = {
  /** The speaker for this whole turn (may be null for single-track transcripts). */
  speaker: string | null;
  /** Indices INTO THE ORIGINAL segments array, in order, that make up this turn.
   *  Indices (not copies) so the renderer keeps each cue's own data-seg-idx for
   *  sub-segment annotation anchoring. */
  segIndices: number[];
  /** First cue's startMs in the turn (the turn's seek target / sort key). */
  startMs: number;
  /** Last cue's endMs in the turn. */
  endMs: number;
};

/**
 * Group consecutive same-speaker segments into turns, preserving input order.
 *
 * A new turn begins whenever `speaker` differs from the previous segment's
 * speaker (strict `!==`; `null` is its own speaker and groups with adjacent
 * `null`s). Input order is NEVER re-sorted — multi-track SRT can have
 * overlapping time ranges (see {@link parseSrt} in `./srt`), so position, not
 * time, defines turn boundaries. `startMs` is the first cue's start and `endMs`
 * is the last cue's end of each turn. Returns `[]` for `[]`.
 *
 * INVARIANT — pass TEMPORALLY-ORDERED cues: callers must order `segments` by time
 * (see {@link orderByTime} in `./order`) BEFORE grouping. Because grouping is
 * position-based, raw SRT block order (which clusters a multi-track file by speaker)
 * would collapse a speaker's interleaved cues into one turn and lose the interjection
 * structure. The session loaders apply `orderByTime` first; any new caller must too.
 */
export function groupIntoTurns(segments: TurnSegment[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Strict !==: a speaker change (including to/from null) opens a new turn.
    if (current === null || seg.speaker !== current.speaker) {
      current = {
        speaker: seg.speaker,
        segIndices: [i],
        startMs: seg.startMs,
        endMs: seg.endMs,
      };
      turns.push(current);
    } else {
      current.segIndices.push(i);
      // endMs tracks the LAST cue of the turn (not a max — order is authoritative).
      current.endMs = seg.endMs;
    }
  }

  return turns;
}

// Pure temporal ordering for transcript cues. No DOM, no I/O — unit-testable.
//
// A transcript is stored/parsed in SRT block order (`cb_segments.ordinal`), which is
// NOT temporal order for a MULTI-TRACK file: each speaker's track is emitted as a run
// of cues, so two speakers' cues interleave in time but appear clustered by speaker
// in block order. Reading order should follow the VIDEO — the cue said earliest is
// shown first — so the follow-along highlight advances straight down the page and a
// researcher interjection appears between the participant phrases it actually
// interrupted (instead of all of one speaker's cues, then all of the other's).
//
// We order by `startMs` ascending, breaking ties by `idx` (the SRT ordinal) so the
// result is deterministic and a tie preserves original file order. This does NOT
// merge or drop cues and does NOT touch their ids/times — it only reorders — so
// id-keyed anchoring (annotations, the coder×code matrix) is unaffected; consumers
// that key off array INDEX simply see the temporal index consistently.

/** The minimal cue shape ordering reads. `CloudSegment` is assignable to it. */
export type OrderableCue = { startMs: number; idx: number };

/**
 * Return a NEW array of `cues` sorted into temporal (video) order: by `startMs`
 * ascending, ties broken by `idx` ascending. Does not mutate the input.
 */
export function orderByTime<T extends OrderableCue>(cues: T[]): T[] {
  return [...cues].sort((a, b) => a.startMs - b.startMs || a.idx - b.idx);
}

// Pure cue-resolution helpers: given time-ranged cues and a playhead time, which
// cue is "current". No DOM, no I/O — unit-testable and importable anywhere.
//
// The hard case is MULTI-TRACK transcripts (see `parseSrt`): each speaker has its
// own track, so cues from different speakers OVERLAP in time, and one speaker's
// long, coarse cue can temporally contain another speaker's short, specific phrases.
// (A Zoom per-speaker SRT also tends to inflate a cue's end to the speaker's NEXT
// utterance, so a 15-word interjection can carry an 80-second span.) Picking the
// FIRST cue that contains the playhead would lock onto that long block; the TIGHTEST
// (shortest-span) containing cue is the phrase actually being spoken.

/** The minimal cue shape these helpers read. `CloudSegment` is assignable to it. */
export type TimedCue = { startMs: number; endMs: number };

/**
 * Index of the cue being spoken at `tMs` — the TIGHTEST cue whose `[startMs, endMs)`
 * contains `tMs` — or -1 if none contains it.
 *
 * Shortest-span wins on overlap so the follow-along highlight advances phrase-by-
 * phrase instead of sticking on a long track-level block. Ties (equal span) resolve
 * to the earliest cue for stability. A LINEAR scan: multi-track ranges are
 * overlapping and non-monotonic, so a binary search would be wrong, and at a few
 * hundred cues / ~4 Hz this is free.
 */
export function findActiveIndex(cues: TimedCue[], tMs: number): number {
  let best = -1;
  let bestSpan = Infinity;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (tMs >= c.startMs && tMs < c.endMs) {
      const span = c.endMs - c.startMs;
      if (span < bestSpan) {
        bestSpan = span;
        best = i;
      }
    }
  }
  return best;
}

/**
 * Index of the cue a marker at `tMs` should ATTACH to — like {@link findActiveIndex}
 * but it never returns -1 for a non-empty transcript, so every marker (e.g. a live
 * flag whose record-relative time rarely lands exactly inside a cue) maps onto some
 * text.
 *
 * Resolution: the tightest CONTAINING cue if any contains `tMs`; otherwise the cue
 * with the smallest time GAP to `tMs` (to its start if `tMs` precedes it, else to its
 * end), ties to the earliest cue. Returns -1 only for an empty transcript.
 */
export function nearestCueIndex(cues: TimedCue[], tMs: number): number {
  const containing = findActiveIndex(cues, tMs);
  if (containing >= 0) return containing;

  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const gap = tMs < c.startMs ? c.startMs - tMs : tMs - c.endMs;
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

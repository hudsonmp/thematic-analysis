/**
 * retroSkip — PURE transport policy for "don't make me sit through the
 * retrospectives".
 *
 * A session recording interleaves the participant WORKING (requirements,
 * specification, editing) with the participant ANSWERING retrospective
 * questions. On a coding pass the retrospectives are dead air: they carry no
 * screen work to code, and they are long. Scrubbing past them by hand costs a
 * hunt for the boundary every single time — and the boundaries are already
 * known, materialized as `cb_session_episodes` from the participant's own step
 * advances (see app/actions/episodes.ts). So the player reads that timeline and
 * jumps.
 *
 * Episode marks are POINTS, not spans: episode i owns [tStart_i, tStart_{i+1}).
 * "Inside a retrospective" therefore means "the last mark whose start has passed
 * is a retrospective one", and the exit is the next mark that ISN'T — which may
 * be several marks along, since the general retrospective is three questions in
 * a row. When no non-retro mark follows, the working part of the session is over
 * and the caller parks at the end rather than playing the tail out.
 *
 * Kept free of the DOM (the caller feeds the clock and performs the seek) so the
 * boundary arithmetic is testable without a media element.
 */

/** One episode mark, reduced to what the policy needs. */
export type EpisodeMark = {
  tStartMs: number;
  /** The episode PRESET's display name — the retro test is on this. */
  name: string;
};

/** What to do with the playhead. `null` from `retroSkipTarget` means "nothing". */
export type RetroSkip =
  /** Jump to `toMs` and keep playing — real work resumes there. */
  | { kind: 'jump'; toMs: number }
  /** Everything left is retrospective: park at the end of the video, paused. */
  | { kind: 'end' };

/**
 * Retrospective episodes are named by the canonical step map in
 * app/actions/episodes.ts — "Scenario Retrospective" and "General Retrospective
 * Question I/II/III". Nothing else in that map contains "retro", and the match
 * is deliberately loose (substring, case-insensitive) so a researcher who renames
 * or adds a retrospective preset keeps the behavior for free.
 */
export const isRetroEpisodeName = (name: string): boolean => /retro/i.test(name);

/**
 * Index of the episode the playhead sits in — the LAST mark whose start has
 * passed — or -1 before the first mark. `marks` must be sorted by `tStartMs`.
 */
export function episodeIndexAt(marks: EpisodeMark[], tMs: number): number {
  let idx = -1;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].tStartMs <= tMs) idx = i;
    else break;
  }
  return idx;
}

/**
 * Where the playhead should go from `tMs`, or `null` to leave it alone (the
 * common case: not in a retrospective). `marks` must be sorted by `tStartMs`.
 */
export function retroSkipTarget(marks: EpisodeMark[], tMs: number): RetroSkip | null {
  const idx = episodeIndexAt(marks, tMs);
  if (idx < 0 || !isRetroEpisodeName(marks[idx].name)) return null;
  for (let i = idx + 1; i < marks.length; i++) {
    if (!isRetroEpisodeName(marks[i].name)) return { kind: 'jump', toMs: marks[i].tStartMs };
  }
  return { kind: 'end' };
}

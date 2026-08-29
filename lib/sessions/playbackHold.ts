/**
 * playbackHold — PURE transport policy for "pause while I code, resume when I stop".
 *
 * Coding a transcript is a two-handed gesture: the coder drags a highlight while
 * the video keeps talking, so by the time the popup lands they have lost thirty
 * seconds of audio and have to scrub back. Reaching for the spacebar first works
 * exactly until you forget, which is every time. So the player pauses ITSELF the
 * instant a highlight starts and hands playback back the instant the coder is
 * done — the transport follows the gesture rather than the other way round.
 *
 * The whole difficulty is not the pausing, it is the RESUMING: auto-resume must
 * never start a video the coder deliberately stopped. This module owns that as a
 * one-bit debt — we only ever resume playback we ourselves interrupted:
 *
 *   • engage while PLAYING   → pause, and remember we owe a resume
 *   • engage while PAUSED    → do nothing; their pause is theirs to undo
 *   • playing again while we hold → they hit play mid-coding; drop the debt so
 *     the end of the gesture does not yank the video back to a stop
 *   • disengage while holding → resume, debt settled
 *
 * Kept free of the DOM (the caller feeds `playing` and applies the effect) so the
 * latch is testable without a media element. `useCodingPauseHold` does the wiring.
 */

/** One sample of the world: is a coding gesture live, and is the video running? */
export type HoldInput = {
  /** A highlight is in flight or a coding surface (popup/composer) has the floor. */
  engaged: boolean;
  /** `!video.paused` at this instant — read from the element, never from state. */
  playing: boolean;
};

/** What the caller should do to the media element, if anything. */
export type HoldEffect = 'pause' | 'resume' | null;

export type PlaybackHold = {
  /** Feed a sample; returns the transport call to make (at most one per sample). */
  update: (input: HoldInput) => HoldEffect;
  /** Abandon the debt without resuming (unmount, session/source change). */
  reset: () => void;
  /** True while this module is the reason the video is paused. */
  isHolding: () => boolean;
};

/** The three ways the app can tell a coding gesture is under way. */
export type GestureSignals = {
  /** A coding surface has the floor: popup, comment composer, pending span. */
  surfaceOpen: boolean;
  /** A non-collapsed DOM selection sits inside the transcript. */
  selectionLive: boolean;
  /** A pointer is down inside the transcript. */
  pointerDown: boolean;
};

/**
 * Is a coding gesture live? `holding` (are we already the reason it is paused)
 * is part of the question, because the pointer only SUSTAINS a hold — it never
 * starts one.
 *
 * Both halves of that matter. Mousedown collapses the previous selection, so
 * starting a second highlight reads for a moment as "nothing selected, nothing
 * open" and the video would blip into life between two drags. And a bare click
 * — click-to-seek — is a pointer-down with no selection either side of it, which
 * must not stop a running video.
 */
export function isGestureLive(
  { surfaceOpen, selectionLive, pointerDown }: GestureSignals,
  holding: boolean,
): boolean {
  return surfaceOpen || selectionLive || (pointerDown && holding);
}

export function createPlaybackHold(): PlaybackHold {
  let holding = false;

  return {
    update({ engaged, playing }) {
      if (engaged) {
        if (holding) {
          // We hold, yet it is running: the coder started it themselves. The
          // video is theirs again — releasing the selection must not stop it.
          if (playing) holding = false;
          return null;
        }
        if (!playing) return null; // their pause, not ours: take on no debt
        holding = true;
        return 'pause';
      }
      if (!holding) return null;
      holding = false;
      return 'resume';
    },
    reset() {
      holding = false;
    },
    isHolding: () => holding,
  };
}

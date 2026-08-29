/**
 * reflow — PURE scheduling policy for measurement-driven layout passes.
 *
 * Two surfaces in this app place elements by MEASURING the DOM: the transcript's
 * annotation gutter (SessionPlayer) and the exemplar comment rail. Both must
 * re-measure whenever their container changes width — which, during a pane drag,
 * happens many times per frame.
 *
 * The naive wiring (one layout pass per resize/observer callback) is what makes a
 * drag feel sticky: the callbacks arrive far faster than frames, each pass forces
 * a synchronous reflow, and the browser spends the frame budget re-measuring the
 * same geometry instead of painting. This module owns the "at most one pass per
 * frame" rule, kept pure (rAF is injected) so the coalescing is testable without
 * a DOM.
 *
 * It also tracks whether a drag is IN FLIGHT (`isReflowing`). Callers use that to
 * suppress CSS transitions on the properties they are about to write: an element
 * that animates `top` over 150ms can never keep up with a pointer, so it trails
 * the text it annotates and only settles a beat after the drag stops.
 */

/** Injection seam so tests can drive frames by hand. */
export type FrameApi = {
  raf: (cb: FrameRequestCallback) => number;
  caf: (id: number) => void;
};

export type ReflowScheduler = {
  /** Ask for a layout pass on the next frame. Cheap; call it from every event. */
  request: () => void;
  /** Drop any pending pass (unmount). */
  cancel: () => void;
  /** Run a pending pass NOW (e.g. a layout effect that must not paint stale). */
  flush: () => void;
  /** True from the first request until a frame passes with no further requests. */
  isReflowing: () => boolean;
};

const defaultFrames: FrameApi = {
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
};

/**
 * Coalesce any number of `request()` calls into a single `run()` per frame.
 *
 * `isReflowing()` goes true on the first request and stays true through the pass
 * plus one settle frame, so a burst of resize callbacks reads as ONE continuous
 * drag rather than flickering on and off between frames.
 */
export function createReflowScheduler(
  run: () => void,
  frames: FrameApi = defaultFrames,
  /**
   * Called on each EDGE of `isReflowing()` — never per pass. Callers hang the
   * transition-suppression mark off this instead of polling every frame.
   */
  onReflowingChange?: (reflowing: boolean) => void,
): ReflowScheduler {
  let frame: number | null = null;
  let settle: number | null = null;
  let reflowing = false;

  const setReflowing = (next: boolean) => {
    if (reflowing === next) return;
    reflowing = next;
    onReflowingChange?.(next);
  };

  const clearSettle = () => {
    if (settle !== null) {
      frames.caf(settle);
      settle = null;
    }
  };

  const pass = () => {
    frame = null;
    run();
    // One quiet frame ends the drag. Re-armed by any request that lands first,
    // which is why a continuous drag never drops the mark mid-flight.
    clearSettle();
    settle = frames.raf(() => {
      settle = null;
      setReflowing(false);
    });
  };

  return {
    request() {
      setReflowing(true);
      clearSettle();
      if (frame !== null) return; // already booked for this frame
      frame = frames.raf(pass);
    },
    cancel() {
      if (frame !== null) {
        frames.caf(frame);
        frame = null;
      }
      clearSettle();
      setReflowing(false);
    },
    flush() {
      if (frame !== null) {
        frames.caf(frame);
        frame = null;
      }
      pass();
    },
    isReflowing: () => reflowing,
  };
}

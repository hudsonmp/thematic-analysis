'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  createPlaybackHold,
  isGestureLive,
  type PlaybackHold,
} from '@/lib/sessions/playbackHold';

type Ref<T> = { current: T | null };

/** Is there a live (non-collapsed) text selection inside `root`? */
function selectionTouches(root: HTMLElement | null): boolean {
  if (!root) return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  // commonAncestorContainer covers a multi-cue drag in one check; it is a text
  // node for a within-cue selection, which `contains` handles.
  return root.contains(sel.getRangeAt(0).commonAncestorContainer);
}

/**
 * useCodingPauseHold — hold the video still for the duration of a coding gesture.
 *
 * The gesture is "highlight a span, then say something about it", and it starts
 * the moment the highlight becomes non-empty. So the pause hangs off
 * `selectionchange`, not off mouseup: by mouseup a drag across two sentences has
 * already let four seconds of audio run past, which is the whole complaint. The
 * event fires on the first character crossed — and on ⇧-arrow selection too, which
 * a mouse-only wiring would miss.
 *
 * `engaged` carries the part of the gesture that outlives the DOM selection: the
 * coding popup, the comment composer, a popup reopened from the gutter (which has
 * no DOM selection at all). Playback resumes when BOTH are quiet — no timer, no
 * settle delay; the coder asked for the transport back the instant they let go.
 *
 * Two guards keep this from fighting the coder, both of them about resuming:
 *
 *   • The pointer SUSTAINS an existing hold. Mousedown collapses the old
 *     selection, so starting a second highlight momentarily reads as "nothing
 *     selected" — without this the video would blip into life between two drags.
 *     A pointer-down never STARTS a hold, so a bare click-to-seek is untouched.
 *   • Whose pause is it. {@link createPlaybackHold} only resumes playback it
 *     stopped, so highlighting a span of an already-paused video leaves it
 *     paused, and hitting play mid-coding hands the transport back for good.
 */
export function useCodingPauseHold({
  videoRef,
  transcriptRef,
  engaged,
  enabled,
}: {
  videoRef: Ref<HTMLVideoElement>;
  transcriptRef: Ref<HTMLElement>;
  /** A coding surface has the floor (popup / composer / pending selection). */
  engaged: boolean;
  /** Off for read-only viewers, and for anyone who wants the video to just run. */
  enabled: boolean;
}): void {
  const holdRef = useRef<PlaybackHold | null>(null);
  if (holdRef.current === null) holdRef.current = createPlaybackHold();
  const hold = holdRef.current;

  // Read during events, so they must be current WITHOUT re-binding listeners.
  // Mirrored in an effect, not during render (the repo's ref rule).
  const engagedRef = useRef(engaged);
  const enabledRef = useRef(enabled);
  const pointerDownRef = useRef(false);

  const sync = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!enabledRef.current) {
      // Switched off mid-hold: give the video back rather than strand it paused.
      if (hold.isHolding()) {
        hold.reset();
        video.play().catch(() => {});
      }
      return;
    }
    const live = isGestureLive(
      {
        surfaceOpen: engagedRef.current,
        selectionLive: selectionTouches(transcriptRef.current),
        pointerDown: pointerDownRef.current,
      },
      hold.isHolding(),
    );
    const effect = hold.update({ engaged: live, playing: !video.paused });
    // play() rejects when a pause lands on its heels (or autoplay policy bites);
    // the transport is right either way, so swallow it.
    if (effect === 'pause') video.pause();
    else if (effect === 'resume') video.play().catch(() => {});
  }, [hold, videoRef, transcriptRef]);

  useEffect(() => {
    const onSelectionChange = () => sync();
    const onPointerDown = (e: PointerEvent) => {
      pointerDownRef.current =
        transcriptRef.current?.contains(e.target as Node) ?? false;
      sync();
    };
    const onPointerUp = () => {
      pointerDownRef.current = false;
      sync();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerdown', onPointerDown);
    // `pointercancel` too: a drag that leaves the window never sees pointerup.
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
    };
  }, [sync, transcriptRef]);

  // The coder pressing play mid-coding is the signal to stop owning the
  // transport — re-evaluate on the element's own events, not on React state.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => sync();
    video.addEventListener('play', onPlay);
    return () => video.removeEventListener('play', onPlay);
  }, [sync, videoRef]);

  // Mirror the React-side signals for the event handlers, then act on them: a
  // popup opened from the gutter engages with no selection and no pointer
  // sequence over the transcript, so nothing else would tick.
  useEffect(() => {
    engagedRef.current = engaged;
    enabledRef.current = enabled;
    sync();
  }, [engaged, enabled, sync]);

  useEffect(() => () => holdRef.current?.reset(), []);
}

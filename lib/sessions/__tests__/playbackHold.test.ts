import { describe, it, expect } from 'vitest';
import { createPlaybackHold, isGestureLive, type GestureSignals } from '../playbackHold';

const quiet: GestureSignals = { surfaceOpen: false, selectionLive: false, pointerDown: false };

describe('isGestureLive', () => {
  it('a bare click (pointer down, nothing selected) is not a gesture', () => {
    // Click-to-seek must never stop a running video.
    expect(isGestureLive({ ...quiet, pointerDown: true }, false)).toBe(false);
  });

  it('the pointer sustains a hold across the gap between two drags', () => {
    // Mousedown collapsed the first selection and closed the popup; without this
    // the video would blip into life before the second highlight lands.
    expect(isGestureLive({ ...quiet, pointerDown: true }, true)).toBe(true);
  });

  it('a live selection or an open surface is enough on its own', () => {
    expect(isGestureLive({ ...quiet, selectionLive: true }, false)).toBe(true);
    expect(isGestureLive({ ...quiet, surfaceOpen: true }, false)).toBe(true);
  });

  it('nothing happening is nothing happening, hold or no hold', () => {
    expect(isGestureLive(quiet, false)).toBe(false);
    // Pointer up + selection cleared + popup closed: the coder is done.
    expect(isGestureLive(quiet, true)).toBe(false);
  });
});

describe('createPlaybackHold', () => {
  it('pauses on the first engaged tick and resumes when the gesture ends', () => {
    const h = createPlaybackHold();
    expect(h.update({ engaged: true, playing: true })).toBe('pause');
    expect(h.isHolding()).toBe(true);
    // Further engaged ticks (the drag continues, the popup opens) are no-ops —
    // pause() is idempotent but re-firing it would churn `pause` events.
    expect(h.update({ engaged: true, playing: false })).toBe(null);
    expect(h.update({ engaged: false, playing: false })).toBe('resume');
    expect(h.isHolding()).toBe(false);
  });

  it('never auto-plays a video the coder paused themselves', () => {
    const h = createPlaybackHold();
    // Engaging while already paused takes on NO resume debt.
    expect(h.update({ engaged: true, playing: false })).toBe(null);
    expect(h.isHolding()).toBe(false);
    expect(h.update({ engaged: false, playing: false })).toBe(null);
  });

  it('drops the debt when the coder hits play mid-coding', () => {
    const h = createPlaybackHold();
    h.update({ engaged: true, playing: true });
    // They want it running while they read ahead — stop owning the transport.
    expect(h.update({ engaged: true, playing: true })).toBe(null);
    expect(h.isHolding()).toBe(false);
    // ...so clearing the selection must not pause or re-resume anything.
    expect(h.update({ engaged: false, playing: true })).toBe(null);
  });

  it('holds again for the NEXT selection after a resume', () => {
    const h = createPlaybackHold();
    h.update({ engaged: true, playing: true });
    h.update({ engaged: false, playing: false });
    expect(h.update({ engaged: true, playing: true })).toBe('pause');
  });

  it('reset abandons the debt without resuming', () => {
    const h = createPlaybackHold();
    h.update({ engaged: true, playing: true });
    h.reset();
    expect(h.isHolding()).toBe(false);
    expect(h.update({ engaged: false, playing: false })).toBe(null);
  });

  it('is idle when nothing is engaged', () => {
    const h = createPlaybackHold();
    expect(h.update({ engaged: false, playing: true })).toBe(null);
    expect(h.update({ engaged: false, playing: false })).toBe(null);
    expect(h.isHolding()).toBe(false);
  });
});

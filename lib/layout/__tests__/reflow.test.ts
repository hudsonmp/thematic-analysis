import { describe, it, expect, vi } from 'vitest';
import { createReflowScheduler } from '../reflow';

/** A hand-driven rAF: frames only advance when the test says so. */
function fakeFrames() {
  let next = 1;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    raf: (cb: FrameRequestCallback) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    caf: (id: number) => {
      pending.delete(id);
    },
    /** Run everything queued for this frame (callbacks queued DURING it wait). */
    tick(now = 0) {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, cb] of due) cb(now);
    },
    get queued() {
      return pending.size;
    },
  };
}

describe('createReflowScheduler', () => {
  it('runs at most once per frame no matter how many requests arrive', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const s = createReflowScheduler(run, frames);

    // A pointer drag fires resize/observer callbacks far faster than frames.
    for (let i = 0; i < 50; i++) s.request();
    expect(run).not.toHaveBeenCalled(); // nothing synchronous in the event
    expect(frames.queued).toBe(1); // 50 requests, ONE frame booked

    frames.tick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('books a fresh frame after the previous one ran', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const s = createReflowScheduler(run, frames);

    s.request();
    frames.tick();
    s.request();
    frames.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel drops a pending pass (unmount must not measure a dead tree)', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const s = createReflowScheduler(run, frames);

    s.request();
    s.cancel();
    frames.tick();
    expect(run).not.toHaveBeenCalled();
  });

  it('cancel is idempotent and a later request still schedules', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const s = createReflowScheduler(run, frames);

    s.cancel();
    s.cancel();
    s.request();
    frames.tick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs immediately on demand, consuming the pending frame', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const s = createReflowScheduler(run, frames);

    s.request();
    s.flush();
    expect(run).toHaveBeenCalledTimes(1);

    // The booked frame must not fire a second, redundant pass.
    frames.tick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports whether a pass is in flight, and clears the mark a frame after the last one', () => {
    const frames = fakeFrames();
    const s = createReflowScheduler(() => {}, frames);

    expect(s.isReflowing()).toBe(false);
    s.request();
    expect(s.isReflowing()).toBe(true); // set on request, not after the pass

    frames.tick(); // the layout pass; a settle frame is booked
    expect(s.isReflowing()).toBe(true);

    frames.tick(); // settle frame: the drag is over
    expect(s.isReflowing()).toBe(false);
  });

  it('reports reflowing EDGES only, so a drag flips the mark exactly twice', () => {
    const frames = fakeFrames();
    const seen: boolean[] = [];
    const s = createReflowScheduler(() => {}, frames, (r) => seen.push(r));

    for (let i = 0; i < 20; i++) s.request(); // burst within one frame
    frames.tick();
    for (let i = 0; i < 20; i++) s.request(); // drag continues
    frames.tick();
    frames.tick(); // settle

    expect(seen).toEqual([true, false]);
  });

  it('cancel reports the falling edge for a drag that never settled', () => {
    const frames = fakeFrames();
    const seen: boolean[] = [];
    const s = createReflowScheduler(() => {}, frames, (r) => seen.push(r));

    s.request();
    s.cancel(); // unmount mid-drag
    expect(seen).toEqual([true, false]);
  });

  it('keeps the reflowing mark set while requests keep arriving', () => {
    const frames = fakeFrames();
    const s = createReflowScheduler(() => {}, frames);

    s.request();
    frames.tick();
    s.request(); // drag still going: re-arms before the settle frame runs
    frames.tick();
    expect(s.isReflowing()).toBe(true);
  });
});

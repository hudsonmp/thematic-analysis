'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { createReflowScheduler, type ReflowScheduler } from '@/lib/layout/reflow';

type Ref = { current: HTMLElement | null };

/** The per-frame inputs, behind methods: see the note inside `useReflow`. */
function createLatest() {
  let run: () => void = () => {};
  let mark: HTMLElement | null = null;
  return {
    set(nextRun: () => void, nextMark: HTMLElement | null) {
      run = nextRun;
      mark = nextMark;
    },
    run: () => run(),
    mark: () => mark,
  };
}

/**
 * useReflow — run a measurement-driven layout pass whenever the boxes it
 * measures actually change size, at most once per frame.
 *
 * Why not `window.addEventListener('resize')`, which is what the call sites used
 * to do: a window resize is neither necessary nor sufficient for a relayout.
 *
 *   * NOT SUFFICIENT — dragging a pane divider (an in-page sidebar, an editor's
 *     preview split, docked devtools) changes the CONTAINER's width while the
 *     window keeps its size, so no resize event fires and the measured elements
 *     sit at stale coordinates until some unrelated render knocks them loose.
 *     That is the "it stays in place for half a second and then jumps".
 *   * NOT NECESSARY — a window resize that leaves this container alone (a taller
 *     window, a sibling pane absorbing the delta) buys a full re-measure for
 *     nothing.
 *
 * A ResizeObserver on the containers is exactly the right signal, and it fires
 * once on observe, so the first pass comes for free. Passes are coalesced to one
 * per frame by the scheduler; during a drag the observer fires far more often.
 *
 * `markRef` (optional) carries `data-reflowing` for the duration of a drag.
 * Anything that animates a property the layout pass WRITES must switch that
 * transition off under that attribute — a card easing `top` over 150ms cannot
 * track a pointer, so it trails the text it annotates and settles late. The
 * attribute is written imperatively, off the scheduler's reflowing EDGES: a drag
 * must not re-render React, and there is no per-frame polling.
 *
 * `run` may change identity freely (it closes over the layout inputs). Observers
 * are attached once; a changed `run` triggers a synchronous pass in a layout
 * effect, so new geometry is placed before paint rather than a frame late.
 *
 * Returns the scheduler so callers can feed OTHER signals into the same
 * once-per-frame budget (an editor's `update`, a font load) instead of standing
 * up a competing rAF chain beside it.
 */
export function useReflow(
  run: () => void,
  targets: ReadonlyArray<Ref>,
  markRef?: Ref,
): ReflowScheduler {
  // What a frame reads when it fires. Written only inside the layout effect
  // below, and through a method rather than a ref or a property write, so the
  // scheduler's callbacks (created once, in a lazy initializer) never touch a
  // ref during render — the repo's ref rule, enforced by react-hooks/refs.
  const [latest] = useState(createLatest);
  const [scheduler] = useState<ReflowScheduler>(() =>
    createReflowScheduler(
      () => latest.run(),
      undefined,
      (reflowing) => {
        const el = latest.mark();
        if (!el) return;
        if (reflowing) el.setAttribute('data-reflowing', '');
        else el.removeAttribute('data-reflowing');
      },
    ),
  );

  // Declared BEFORE the flush effect: layout effects run in order, so the
  // pass that flushes below always sees this render's `run` and mark element.
  useLayoutEffect(() => {
    latest.set(run, markRef?.current ?? null);
  });

  // `targets` is a fresh array literal on every render at the call sites; depend
  // on the ELEMENTS instead so the observer is not torn down once per render.
  const targetEls = targets.map((t) => t.current);

  useEffect(() => {
    const els = targetEls.filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    const ro = new ResizeObserver(() => scheduler.request());
    for (const el of els) ro.observe(el);

    // A window resize can move a container's OFFSET (and therefore the
    // container-relative tops we compute) without changing its size — e.g. the
    // page re-centres. Cheap to also listen, now that passes are coalesced.
    const onWindowResize = () => scheduler.request();
    window.addEventListener('resize', onWindowResize, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWindowResize);
      scheduler.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduler, ...targetEls]);

  // Data changed (new threads, new blocks, an opened card): place it before the
  // browser paints, not a frame later.
  useLayoutEffect(() => {
    scheduler.flush();
  }, [scheduler, run]);

  return scheduler;
}

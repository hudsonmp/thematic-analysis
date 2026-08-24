'use client';

import { useEffect, useRef } from 'react';
import { createBrowser } from '@/lib/supabase/browser';

/**
 * Live-sync the signed-in coder's OWN annotations across THEIR devices/tabs
 * (SP-A Task 10; #6 realtime + #16 laptop-transcript / monitor-video, same user
 * two tabs). When the coder adds/deletes an annotation in one tab, it
 * appears/disappears in their other tabs — WITHOUT ever surfacing another
 * coder's in-progress work (own-coding isolation).
 *
 * Design (correct over clever — the spec's "simplest correct wiring"): this hook
 * holds NO annotation state of its own. The player keeps rendering the
 * server-loaded `myAnnotations` prop; the hook's only job is to call `onChange`
 * (debounced) when the signed-in coder's OWN rows change, which the player wires
 * to `router.refresh()`. That re-runs the page's server component and re-passes
 * `myAnnotations` WITH the joined code mnemonics — so the server's own
 * (cb_annotation_codes → cb_codes) join stays the single source of truth and we
 * never hand-roll it client-side.
 *
 *   * We subscribe with `postgres_changes` to `cb_annotations` filtered to this
 *     session (filtering server-side keeps off-session traffic off the socket).
 *     Realtime authorizes the stream against the table's RLS SELECT policy using
 *     the JWT the @supabase/ssr browser client carries (hydrated from cookies);
 *     cb_annotations' SELECT is `using(true)`, so we receive ALL coders' changes
 *     and narrow to our own rows here.
 *   * INSERT/UPDATE: act only when `new.coder_id === myUid` → `onChange()`.
 *   * DELETE: the payload carries only the PK under `old` (default replica
 *     identity), with no `coder_id` to gate on. Other coders' deletes are
 *     harmless to refresh on (the server reload is own-scoped and idempotent), so
 *     we fire `onChange()` for any session delete; the refreshed `myAnnotations`
 *     reflects only the coder's own remaining rows.
 *   * Optional: subscribe to `cb_codes` INSERT/UPDATE → `onChange()` so the code
 *     picker refreshes when the codebook changes (both tables are in the
 *     `supabase_realtime` publication; see docs/migrations/13_realtime.sql).
 *
 * The debounce (~150ms) coalesces bursts — e.g. an annotation insert immediately
 * followed by its code-link insert — into a single refresh. The channel is torn
 * down via `removeChannel` on unmount / when the session or uid changes.
 */
export function useRealtimeAnnotations({
  sessionId,
  myUid,
  onChange,
  tables = { annotations: 'cb_annotations', links: 'cb_annotation_codes' },
}: {
  sessionId: string;
  /** The signed-in coder's auth uid; null when unauthenticated (no subscribe). */
  myUid: string | null;
  /** Called (debounced) when the coder's own rows change, to re-load from server. */
  onChange?: () => void;
  /** Which anchor + junction tables to watch — the codebook layer by default;
   *  the action layer (/coding/action) passes its own pair. */
  tables?: { annotations: string; links: string };
}): void {
  const annotationsTable = tables.annotations;
  const linksTable = tables.links;
  // Keep the latest onChange in a ref so the subscription effect can stay keyed
  // solely on (sessionId, myUid) and not re-subscribe when the callback identity
  // changes between renders.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!sessionId || !myUid) return;

    const sb = createBrowser();

    // Debounced bridge to the server re-load. Coalesces an annotation insert +
    // its code-link insert (and any rapid burst) into one router.refresh().
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fireChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChangeRef.current?.();
      }, 150);
    };

    const channel = sb
      .channel(`realtime:annotations:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: annotationsTable,
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          // Only react to OUR own new rows (other coders' inserts are ignored —
          // own-coding isolation).
          if ((payload.new as { coder_id?: string }).coder_id === myUid) {
            fireChange();
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: annotationsTable,
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          if ((payload.new as { coder_id?: string }).coder_id === myUid) {
            fireChange();
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: annotationsTable,
          filter: `session_id=eq.${sessionId}`,
        },
        () => {
          // DELETE carries only the PK under `old` (no coder_id to gate on). A
          // server re-load is own-scoped and idempotent, so refreshing on any
          // session delete is safe; the refreshed list reflects only our own
          // remaining rows.
          fireChange();
        },
      )
      // Codebook changes → refresh the code picker (and any code mnemonics shown
      // in the rail). Cheap; cb_codes is in the realtime publication.
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'cb_codes' },
        () => fireChange(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'cb_codes' },
        () => fireChange(),
      )
      // JUNCTION-only changes: addCodeToAnnotation / removeCodeFromAnnotation write
      // cb_annotation_codes WITHOUT touching cb_annotations, so without these a
      // second tab's chips/braces go stale until an unrelated event fires. The
      // junction payload carries no coder_id / session_id to filter on — fire
      // unconditionally; the refetch is own-scoped, debounced, and cheap.
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: linksTable },
        () => fireChange(),
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: linksTable },
        () => fireChange(),
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void sb.removeChannel(channel);
    };
  }, [sessionId, myUid, annotationsTable, linksTable]);
}

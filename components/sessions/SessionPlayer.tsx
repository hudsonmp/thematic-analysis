'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CloudSegment } from '@/app/actions/sessions';
import {
  addAnnotation,
  deleteAnnotation,
  type MyAnnotationView,
} from '@/app/actions/annotations';

/** Minimal code shape the picker needs (flattened from the codebook tree). */
type CodeOption = { id: string; mnemonic: string; name: string };

/** Format a millisecond offset as `mm:ss` (minutes uncapped past 60). */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Render a span as `mm:ss–mm:ss`. */
function formatSpan(startMs: number, endMs: number): string {
  return `${formatTime(startMs)}–${formatTime(endMs)}`;
}

/**
 * Index of the segment whose [startMs, endMs) contains `tMs`, or -1.
 *
 * A LINEAR scan, deliberately: multi-track transcripts have overlapping,
 * non-monotonic time ranges (see `parseSrt`), so a binary search would be wrong
 * there. At a few hundred segments and the browser's `timeupdate` cadence
 * (~4 Hz) this is free. The first containing segment wins on overlap.
 */
function findActiveIndex(segments: CloudSegment[], tMs: number): number {
  for (let i = 0; i < segments.length; i++) {
    if (tMs >= segments[i].startMs && tMs < segments[i].endMs) return i;
  }
  return -1;
}

/**
 * Two-pane participant-session player: a 2/3-width video on the left and a
 * 1/3-width synchronized, click-to-seek, brushable transcript on the right,
 * plus (when coding is enabled) a coding rail.
 *
 * Sync (video → transcript): when SYNC is on (default), the video's `timeupdate`
 * — which fires on play AND on seek/scrub/fast-forward — recomputes the active
 * segment; we highlight that row and scroll it into view, so scrubbing the video
 * drags the transcript along. The explicit Sync/Unsync toggle turns this off so
 * the coder can read and scroll freely without being yanked back to the playhead
 * (the highlight still tracks, but no forced scroll).
 *
 * Seek (transcript → video): clicking a row's TIMESTAMP sets `currentTime` to
 * that segment's start and plays. Clicking the row BODY starts/replaces the
 * selection at that segment; shift-clicking another row extends the selection to
 * the contiguous range [min, max] of the two clicked rows.
 *
 * Coding (Task 9, cb_annotations): with a selection, pick a code → "Apply code"
 * → `addAnnotation` writes a `cb_annotations` row owned by the SIGNED-IN coder
 * (coder_id = auth.uid(), enforced server-side; there is NO coder input). SP-A
 * anchors at whole-segment granularity: the annotation's `segment_id` is the
 * FIRST selected segment's real `cb_segments.id` and the char range is the whole
 * segment text (`charStart:0, charEnd:text.length`); the recording-clock span
 * `[tStartMs,tEndMs]` is the brushed selection's [minStart,maxEnd]. SP-B will add
 * sub-segment char ranges. The rail shows ONLY the signed-in coder's OWN
 * annotations (own-coding isolation): click a rail row → seek to its `tStartMs`;
 * ✕ → `deleteAnnotation`. Every mutation calls `router.refresh()` so the page
 * re-loads `myAnnotations` server-side; no Server Action runs during client
 * render.
 *
 * NOTE: the comments panel (`cb_memos`) is intentionally NOT re-enabled here —
 * it awaits its own migration. The coding surface is gated behind `codingEnabled`
 * so a session viewed without codebook context still renders the player.
 */
export default function SessionPlayer({
  id,
  pidLabel,
  segments,
  durationMs,
  codingEnabled = false,
  versionId = null,
  codes = [],
  myAnnotations = [],
}: {
  id: string;
  pidLabel: string;
  segments: CloudSegment[];
  durationMs: number;
  /** Render the coding toolbar + own-coding rail. */
  codingEnabled?: boolean;
  /** The original transcript version id annotations anchor to (version_id). */
  versionId?: string | null;
  codes?: CodeOption[];
  /** The signed-in coder's OWN annotations for this session (own-coding view). */
  myAnnotations?: MyAnnotationView[];
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [activeIdx, setActiveIdx] = useState(-1);

  // When ON (default), the transcript follows the video: on every `timeupdate`
  // (play AND seek/scrub) we highlight the active segment and scroll it into
  // view. When OFF, the highlight still tracks but we never force-scroll, so the
  // coder can read ahead freely. `synced` is mirrored into a ref so the
  // scroll-into-view effect can read the latest value without re-keying on it.
  const [synced, setSynced] = useState(true);
  const syncedRef = useRef(true);
  useEffect(() => {
    syncedRef.current = synced;
  }, [synced]);

  // Span selection over transcript segments. `anchorIdx` is the first clicked
  // row; `headIdx` is the far end (set by shift-click / "extend to here"). The
  // covered range is [min,max] inclusive — `null` means no selection.
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);
  const [headIdx, setHeadIdx] = useState<number | null>(null);

  // Coding form state. (No coder input — the coder is the signed-in user.)
  const [codeFilter, setCodeFilter] = useState('');
  const [selectedCodeId, setSelectedCodeId] = useState('');
  const [applying, setApplying] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const tMs = video.currentTime * 1000;
    const idx = findActiveIndex(segments, tMs);
    setActiveIdx((prev) => (prev === idx ? prev : idx));
  }, [segments]);

  // Scroll the active row into view when it changes — but only while SYNCED.
  // Runs as an effect (post-render) so the row ref is populated. Reading
  // `syncedRef` (not `synced`) keeps the effect keyed solely on `activeIdx`, so
  // toggling sync mid-playback doesn't retroactively scroll.
  useEffect(() => {
    if (activeIdx < 0) return;
    if (!syncedRef.current) return;
    rowRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const seekTo = useCallback((startMs: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = startMs / 1000;
    void video.play();
  }, []);

  // --- Selection ----------------------------------------------------------

  const selectionRange = useMemo<[number, number] | null>(() => {
    if (anchorIdx === null) return null;
    const head = headIdx ?? anchorIdx;
    return [Math.min(anchorIdx, head), Math.max(anchorIdx, head)];
  }, [anchorIdx, headIdx]);

  // The selection's [minStart, maxEnd] span (recording clock) + the ANCHOR
  // segment — the first covered row, which the annotation anchors to in SP-A
  // (whole-segment granularity; SP-B subdivides the char range). Recomputed
  // from the inclusive row range.
  const selection = useMemo(() => {
    if (!selectionRange) return null;
    const [lo, hi] = selectionRange;
    const anchorSeg = segments[lo];
    if (!anchorSeg) return null;
    let minStart = Infinity;
    let maxEnd = -Infinity;
    let count = 0;
    for (let i = lo; i <= hi; i++) {
      const seg = segments[i];
      if (!seg) continue;
      minStart = Math.min(minStart, seg.startMs);
      maxEnd = Math.max(maxEnd, seg.endMs);
      count += 1;
    }
    if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return null;
    return {
      startMs: minStart,
      endMs: maxEnd,
      anchorSegmentId: anchorSeg.id,
      anchorTextLength: anchorSeg.text.length,
      count,
      rowLo: lo,
      rowHi: hi,
    };
  }, [selectionRange, segments]);

  const selectRow = useCallback((i: number, extend: boolean) => {
    if (extend && anchorIdx !== null) {
      setHeadIdx(i);
    } else {
      setAnchorIdx(i);
      setHeadIdx(i);
    }
  }, [anchorIdx]);

  const clearSelection = useCallback(() => {
    setAnchorIdx(null);
    setHeadIdx(null);
  }, []);

  // --- Mutations ----------------------------------------------------------

  const handleApplyCode = useCallback(async () => {
    if (!selection || !selectedCodeId || !versionId) return;
    setApplying(true);
    setError(null);
    try {
      await addAnnotation({
        sessionId: id,
        versionId,
        // SP-A anchors the whole annotation to the FIRST selected segment.
        segmentId: selection.anchorSegmentId,
        charStart: 0,
        charEnd: selection.anchorTextLength,
        tStartMs: selection.startMs,
        tEndMs: selection.endMs,
        kind: 'code',
        codeIds: [selectedCodeId],
      });
      clearSelection();
      setSelectedCodeId('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply code.');
    } finally {
      setApplying(false);
    }
  }, [selection, selectedCodeId, versionId, id, clearSelection, router]);

  const handleDeleteAnnotation = useCallback(async (annotationId: string) => {
    setBusyId(annotationId);
    setError(null);
    try {
      await deleteAnnotation(annotationId);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete annotation.');
    } finally {
      setBusyId(null);
    }
  }, [router]);

  // --- Derived view helpers ----------------------------------------------

  const filteredCodes = useMemo(() => {
    const q = codeFilter.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter(
      (c) =>
        c.mnemonic.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    );
  }, [codes, codeFilter]);

  // Which transcript segment ids carry at least one of the signed-in coder's
  // annotations (for a small edge marker on the row). Own-coding only.
  const annotatedSegmentIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of myAnnotations) set.add(a.segmentId);
    return set;
  }, [myAnnotations]);

  const canApply =
    !!selection && !!selectedCodeId && !!versionId && !applying;

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">
          Participant{' '}
          <span className="font-mono text-foreground/50">({pidLabel})</span>
        </h1>
        <p className="text-sm text-foreground/60">
          Total duration{' '}
          <span className="font-mono">{formatTime(durationMs)}</span>
          {' · '}
          {segments.length} segment{segments.length === 1 ? '' : 's'}
          {codingEnabled && (
            <>
              {' · '}
              {myAnnotations.length} annotation
              {myAnnotations.length === 1 ? '' : 's'}
            </>
          )}
        </p>
      </header>

      {error && (
        <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left (2/3): video + (when enabled) coding toolbar + own-coding rail */}
        <div className="space-y-4 lg:col-span-2">
          <video
            ref={videoRef}
            controls
            preload="metadata"
            src={`/api/media/${id}/video`}
            onTimeUpdate={handleTimeUpdate}
            className="w-full bg-black"
          />

          {codingEnabled && (
            <>
              {/* Coding toolbar */}
              <section className="rounded border border-foreground/15 p-3">
                <h2 className="mb-2 text-sm font-semibold">Apply code</h2>
                {selection ? (
                  <p className="mb-2 text-sm">
                    Selection{' '}
                    <span className="font-mono">
                      {formatSpan(selection.startMs, selection.endMs)}
                    </span>{' '}
                    <span className="text-foreground/50">
                      ({selection.count} segment
                      {selection.count === 1 ? '' : 's'})
                    </span>{' '}
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="ml-1 text-xs text-foreground/60 underline hover:text-foreground"
                    >
                      Clear
                    </button>
                  </p>
                ) : (
                  <p className="mb-2 text-sm text-foreground/50">
                    Click a transcript row to select; shift-click to extend.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={codeFilter}
                    onChange={(e) => setCodeFilter(e.target.value)}
                    placeholder="Filter codes…"
                    className="w-32 rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
                    aria-label="Filter codes"
                  />
                  <select
                    value={selectedCodeId}
                    onChange={(e) => setSelectedCodeId(e.target.value)}
                    className="min-w-40 rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
                    aria-label="Code"
                  >
                    <option value="">
                      {filteredCodes.length ? 'Select a code…' : 'No codes'}
                    </option>
                    {filteredCodes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.mnemonic} — {c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleApplyCode}
                    disabled={!canApply}
                    className="rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-40"
                  >
                    {applying ? 'Applying…' : 'Apply code'}
                  </button>
                </div>
              </section>

              {/* Own-coding rail: ONLY the signed-in coder's annotations. */}
              <section className="rounded border border-foreground/15 p-3">
                <h2 className="mb-2 text-sm font-semibold">
                  My annotations{' '}
                  <span className="font-normal text-foreground/50">
                    ({myAnnotations.length})
                  </span>
                </h2>
                {myAnnotations.length === 0 ? (
                  <p className="text-sm text-foreground/50">No annotations yet.</p>
                ) : (
                  <ul className="divide-y divide-foreground/10">
                    {myAnnotations.map((a) => {
                      const codeLabel =
                        a.codes.map((c) => c.mnemonic).join(', ') || '—';
                      return (
                        <li
                          key={a.id}
                          className="flex items-center gap-2 py-1.5 text-sm"
                        >
                          <button
                            type="button"
                            onClick={() => seekTo(a.tStartMs)}
                            className="flex-1 text-left hover:underline"
                            title={codeLabel}
                          >
                            <span className="font-mono text-xs text-foreground/50">
                              {formatSpan(a.tStartMs, a.tEndMs)}
                            </span>{' '}
                            <span className="font-semibold">{codeLabel}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteAnnotation(a.id)}
                            disabled={busyId === a.id}
                            aria-label="Delete annotation"
                            className="text-foreground/40 hover:text-red-500 disabled:opacity-40"
                          >
                            {'✕'}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        {/* Right (1/3): scrollable, click-to-seek, brushable transcript */}
        <div className="lg:col-span-1">
          {/* Transcript header: Sync/Unsync toggle (follow video on play + seek) */}
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Transcript</h2>
            <button
              type="button"
              onClick={() => setSynced((s) => !s)}
              aria-pressed={synced}
              title={
                synced
                  ? 'Transcript follows the video (click to stop following)'
                  : 'Transcript is not following the video (click to follow)'
              }
              className={`rounded border px-2 py-1 text-xs ${
                synced
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-foreground/30 text-foreground/70 hover:text-foreground'
              }`}
            >
              {synced ? 'Sync: on' : 'Sync: off'}
            </button>
          </div>
          <div
            ref={transcriptRef}
            className="h-[70vh] overflow-y-auto border border-foreground/15 divide-y divide-foreground/10"
          >
            {segments.length === 0 ? (
              <p className="p-4 text-sm text-foreground/60">No transcript</p>
            ) : (
              segments.map((seg, i) => {
                const active = i === activeIdx;
                const inSelection =
                  !!selectionRange && i >= selectionRange[0] && i <= selectionRange[1];
                const isAnnotated =
                  codingEnabled && annotatedSegmentIds.has(seg.id);
                return (
                  <div
                    key={seg.id}
                    ref={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    aria-current={active ? 'true' : undefined}
                    className={`flex items-start gap-1 px-2 py-2 text-sm transition ${
                      inSelection
                        ? 'bg-blue-500/15'
                        : active
                          ? 'bg-foreground/10'
                          : 'hover:bg-foreground/[0.04]'
                    } ${isAnnotated ? 'border-l-2 border-l-emerald-500' : 'border-l-2 border-l-transparent'}`}
                  >
                    {/* Timestamp = seek affordance */}
                    <button
                      type="button"
                      onClick={() => seekTo(seg.startMs)}
                      title="Seek to here"
                      className="mt-px shrink-0 font-mono text-xs text-foreground/40 hover:text-foreground hover:underline"
                    >
                      [{formatTime(seg.startMs)}]
                    </button>
                    {/* Row body = select affordance: click starts/replaces the
                        selection here; shift-click extends to the contiguous
                        range between this row and the anchor. */}
                    <button
                      type="button"
                      onClick={(e) => selectRow(i, e.shiftKey)}
                      title="Click to select; shift-click to extend"
                      className="flex-1 text-left"
                    >
                      {seg.speaker && (
                        <span className="mr-1.5 font-semibold">{seg.speaker}:</span>
                      )}
                      <span className="text-foreground/80">{seg.text}</span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

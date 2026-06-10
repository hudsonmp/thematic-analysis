'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Segment } from '@/lib/transcript/srt';

/** Format a millisecond offset as `mm:ss` (minutes uncapped past 60). */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Index of the segment whose [startMs, endMs) contains `tMs`, or -1.
 *
 * A LINEAR scan, deliberately: multi-track transcripts have overlapping,
 * non-monotonic time ranges (see `parseSrt`), so a binary search would be wrong
 * there. At a few hundred segments and the browser's `timeupdate` cadence
 * (~4 Hz) this is free. The first containing segment wins on overlap.
 */
function findActiveIndex(segments: Segment[], tMs: number): number {
  for (let i = 0; i < segments.length; i++) {
    if (tMs >= segments[i].startMs && tMs < segments[i].endMs) return i;
  }
  return -1;
}

/**
 * Two-pane participant-session player: video on the left, a synchronized,
 * click-to-seek transcript on the right.
 *
 * Sync (video → transcript): the video's `timeupdate` recomputes the active
 * segment; when it changes we highlight that row and scroll it into view — but
 * NOT while the researcher is actively scrolling the transcript themselves
 * (tracked via a short cooldown after the last manual scroll), so reading ahead
 * isn't yanked back to the playhead.
 *
 * Seek (transcript → video): clicking a row sets `currentTime` to that segment's
 * start and plays. The <video> talks to the same-origin `/api/media/<pid>/video`
 * route, so the researcher cookie authorizes the byte-range stream automatically.
 */
export default function SessionPlayer({
  pid,
  firstName,
  segments,
  durationMs,
}: {
  pid: string;
  firstName: string | null;
  segments: Segment[];
  durationMs: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Timestamp (ms) of the researcher's last manual transcript scroll. While
  // within the cooldown we suppress auto-scroll-into-view so reading ahead is
  // not interrupted by the playhead. A ref (not state) — it must not re-render.
  const lastManualScrollRef = useRef(0);
  const AUTOSCROLL_COOLDOWN_MS = 1500;

  const [activeIdx, setActiveIdx] = useState(-1);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const tMs = video.currentTime * 1000;
    const idx = findActiveIndex(segments, tMs);
    setActiveIdx((prev) => (prev === idx ? prev : idx));
  }, [segments]);

  // Scroll the active row into view when it changes, unless the researcher is
  // mid-scroll. Runs as an effect (post-render) so the ref is populated.
  useEffect(() => {
    if (activeIdx < 0) return;
    if (Date.now() - lastManualScrollRef.current < AUTOSCROLL_COOLDOWN_MS) return;
    rowRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const handleSeek = useCallback((startMs: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = startMs / 1000;
    void video.play();
  }, []);

  const onTranscriptScroll = useCallback(() => {
    lastManualScrollRef.current = Date.now();
  }, []);

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">
          {firstName ?? 'Participant'}{' '}
          <span className="font-mono text-foreground/50">({pid})</span>
        </h1>
        <p className="text-sm text-foreground/60">
          Total duration{' '}
          <span className="font-mono">{formatTime(durationMs)}</span>
          {' · '}
          {segments.length} segment{segments.length === 1 ? '' : 's'}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: video */}
        <div>
          <video
            ref={videoRef}
            controls
            preload="metadata"
            src={`/api/media/${pid}/video`}
            onTimeUpdate={handleTimeUpdate}
            className="w-full bg-black"
          />
        </div>

        {/* Right: scrollable, click-to-seek transcript */}
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className="h-[60vh] overflow-y-auto border border-foreground/15 divide-y divide-foreground/10"
        >
          {segments.length === 0 ? (
            <p className="p-4 text-sm text-foreground/60">No transcript</p>
          ) : (
            segments.map((seg, i) => {
              const active = i === activeIdx;
              return (
                <button
                  key={`${seg.idx}-${i}`}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  type="button"
                  onClick={() => handleSeek(seg.startMs)}
                  aria-current={active ? 'true' : undefined}
                  className={`block w-full text-left px-3 py-2 text-sm transition ${
                    active
                      ? 'bg-foreground/10'
                      : 'hover:bg-foreground/[0.04]'
                  }`}
                >
                  <span className="mr-2 font-mono text-xs text-foreground/40">
                    [{formatTime(seg.startMs)}]
                  </span>
                  {seg.speaker && (
                    <span className="mr-1.5 font-semibold">{seg.speaker}:</span>
                  )}
                  <span className="text-foreground/80">{seg.text}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </main>
  );
}

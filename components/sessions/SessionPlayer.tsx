'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { CloudSegment } from '@/app/actions/sessions';
import {
  addAnnotation,
  deleteAnnotation,
  type MyAnnotationView,
} from '@/app/actions/annotations';
import {
  markSessionEpisode,
  deleteSessionEpisode,
  type SessionEpisodeView,
} from '@/app/actions/episodes';
import {
  buildTextAnchor,
  splitIntoPieces,
  type Highlight,
  type TextAnchor,
} from '@/lib/transcript/selection';
import { useRealtimeAnnotations } from './useRealtimeAnnotations';

/** Minimal code shape the picker needs (flattened from the codebook tree). */
type CodeOption = { id: string; mnemonic: string; name: string };

/** A preset episode the coder can mark at a timecode (name + id only). */
type EpisodeOption = { id: string; name: string };

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
 * Resolve the current `window.getSelection()` to a single-segment text anchor.
 *
 * Each segment's text is rendered into ONE element tagged `data-seg-idx={i}`
 * (see the transcript render below). We walk up from the selection's anchor node
 * to that element and require BOTH ends of the selection to live inside the SAME
 * segment element (single-segment selections only in SP-A; multi-segment is
 * SP-future — we clamp to the anchor segment by bailing out). Char offsets are
 * computed by measuring a Range from the start of the segment element to each
 * selection boundary with `toString().length`, which counts rendered text chars
 * and is robust to the text being split across child text nodes.
 *
 * Returns `{ segIdx, anchor }` or `null` (no/collapsed selection, or a selection
 * that isn't fully within one segment's text element).
 */
function resolveSelection(root: HTMLElement | null): { segIdx: number; anchor: TextAnchor } | null {
  if (!root) return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  const startEl = segElementFor(range.startContainer, root);
  const endEl = segElementFor(range.endContainer, root);
  // Require both boundaries inside the SAME segment text element.
  if (!startEl || startEl !== endEl) return null;

  const segIdx = Number(startEl.dataset.segIdx);
  if (!Number.isInteger(segIdx)) return null;

  const text = startEl.textContent ?? '';
  const startOffset = charOffsetWithin(startEl, range.startContainer, range.startOffset);
  const endOffset = charOffsetWithin(startEl, range.endContainer, range.endOffset);
  const anchor = buildTextAnchor(text, startOffset, endOffset);
  if (!anchor) return null;
  return { segIdx, anchor };
}

/** Walk up from `node` to the nearest `[data-seg-idx]` element within `root`, or null. */
function segElementFor(node: Node | null, root: HTMLElement): HTMLElement | null {
  let el: Node | null = node;
  while (el && el !== root) {
    if (el instanceof HTMLElement && el.dataset.segIdx !== undefined) return el;
    el = el.parentNode;
  }
  return null;
}

/**
 * Char offset of (container, offset) measured from the start of `segEl`, in
 * rendered-text chars. Builds a Range from segEl's start to the boundary and
 * reads its string length — correct even when the segment text is split across
 * multiple text nodes.
 */
function charOffsetWithin(segEl: HTMLElement, container: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(segEl);
  r.setEnd(container, offset);
  return r.toString().length;
}

/**
 * Two-pane participant-session player: a 2/3-width video on the left and a
 * 1/3-width synchronized, click-to-seek, brushable transcript on the right,
 * plus (when coding is enabled) a coding rail.
 *
 * Sync (video → transcript): when SYNC is on (default), the video's `timeupdate`
 * — which fires on play AND on seek/scrub/fast-forward — recomputes the active
 * segment; we highlight that row and scroll it into view, so scrubbing the video
 * drags the transcript along. The explicit Sync/Unsync toggle turns this off.
 *
 * Seek (transcript → video): clicking a row's TIMESTAMP sets `currentTime` to
 * that segment's start and plays.
 *
 * Coding (SP-A, cb_annotations): Google-Docs style. SELECT arbitrary TEXT within
 * a single transcript segment (drag → `mouseup` reads `window.getSelection()` and
 * resolves it to char offsets WITHIN that segment's text). Then either:
 *   • pick a code → "Apply code" → `addAnnotation({kind:'code', codeIds:[id], …})`
 *   • "Flag quote ❝" → `addAnnotation({kind:'quote', codeIds:[]})` (a paper quote).
 * Both store `char_start`/`char_end` (the sub-segment range), `quote_text` (the
 * exact substring), and `prefix`/`suffix` (≤32 chars context) for re-anchoring;
 * `[t_start_ms,t_end_ms]` is the whole segment's time (sub-segment word-timing is
 * future). Selecting a segment's ENTIRE text reproduces the old whole-segment
 * anchor (`charStart:0, charEnd:text.length`); the apply/flag buttons are inert
 * until text is brushed, so an empty selection can never write a stray anchor.
 * (`addAnnotation` still accepts whole-segment ranges directly — the canonical
 * reconciliation layer uses that path.)
 *
 * The annotation's `segment_id` is the selected segment's real `cb_segments.id`,
 * `coder_id = auth.uid()` (enforced server-side; NO coder input). The rail shows
 * ONLY the signed-in coder's OWN annotations (own-coding isolation): click a rail
 * row → seek; ✕ → `deleteAnnotation`. A "Quotes" view lists flagged quotes with a
 * copy-to-clipboard button. Highlights in the transcript mark each annotation's
 * char-range (code one color, quote another); clicking a highlight selects its
 * rail row. Every mutation calls `router.refresh()` so the page re-loads
 * `myAnnotations` server-side.
 *
 * Realtime (Task 10): `useRealtimeAnnotations` subscribes to this session's
 * `cb_annotations` changes and, on the signed-in coder's OWN rows changing in
 * ANOTHER tab/device, calls `router.refresh()` (debounced).
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
  myUid = null,
  episodes = [],
  sessionEpisodes = [],
  compareHref = null,
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
  /** The signed-in coder's auth uid — used to scope realtime sync to own rows. */
  myUid?: string | null;
  /** The codebook's preset episodes the coder can mark at a timecode. */
  episodes?: EpisodeOption[];
  /** This session's episode marks (boundaries to navigate / resume by). */
  sessionEpisodes?: SessionEpisodeView[];
  /** Link to the post-hoc, read-only Compare tab (own-coding stays here). */
  compareHref?: string | null;
}) {
  const router = useRouter();

  useRealtimeAnnotations({
    sessionId: id,
    myUid,
    onChange: () => router.refresh(),
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const railRowRefs = useRef<Record<string, HTMLLIElement | null>>({});

  const [activeIdx, setActiveIdx] = useState(-1);

  const [synced, setSynced] = useState(true);
  const syncedRef = useRef(true);
  useEffect(() => {
    syncedRef.current = synced;
  }, [synced]);

  // --- Text selection (Google-Docs style, sub-segment) --------------------
  // The active text selection: a segment index + its char-anchor (charStart,
  // charEnd, quoteText, prefix, suffix). `null` = nothing brushed. Set on
  // `mouseup` within the transcript; cleared after a mutation or on empty.
  const [textSel, setTextSel] = useState<{ segIdx: number; anchor: TextAnchor } | null>(null);

  // Which rail tab is shown: own annotations or just the flagged quotes.
  const [railTab, setRailTab] = useState<'codes' | 'quotes'>('codes');

  // The rail row currently focused (e.g. after clicking a transcript highlight).
  const [focusedAnnId, setFocusedAnnId] = useState<string | null>(null);

  // Coding form state. (No coder input — the coder is the signed-in user.)
  const [codeFilter, setCodeFilter] = useState('');
  const [selectedCodeId, setSelectedCodeId] = useState('');
  const [applying, setApplying] = useState(false);
  const [flagging, setFlagging] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Episode-mark state: which preset episode is selected to mark at the current
  // video timecode, and whether a mark/delete is in flight.
  const [selectedEpisodeId, setSelectedEpisodeId] = useState('');
  const [marking, setMarking] = useState(false);
  const [busyEpisodeMarkId, setBusyEpisodeMarkId] = useState<string | null>(null);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const tMs = video.currentTime * 1000;
    const idx = findActiveIndex(segments, tMs);
    setActiveIdx((prev) => (prev === idx ? prev : idx));
  }, [segments]);

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

  // --- Selection capture --------------------------------------------------

  // On mouseup anywhere in the transcript, read the browser selection and
  // resolve it to a single-segment char anchor. A click (collapsed selection)
  // clears the brush.
  const handleTranscriptMouseUp = useCallback(() => {
    const resolved = resolveSelection(transcriptRef.current);
    setTextSel(resolved);
  }, []);

  const clearSelection = useCallback(() => {
    setTextSel(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // The anchor segment + the char range to persist. With a brushed text
  // selection we use its char offsets; with NO sub-selection there is nothing to
  // code (the toolbar prompts the coder to select text first).
  const pending = useMemo(() => {
    if (!textSel) return null;
    const seg = segments[textSel.segIdx];
    if (!seg) return null;
    return {
      segment: seg,
      anchor: textSel.anchor,
    };
  }, [textSel, segments]);

  // --- Mutations ----------------------------------------------------------

  const handleApplyCode = useCallback(async () => {
    if (!pending || !selectedCodeId || !versionId) return;
    setApplying(true);
    setError(null);
    try {
      const { segment, anchor } = pending;
      await addAnnotation({
        sessionId: id,
        versionId,
        segmentId: segment.id,
        charStart: anchor.charStart,
        charEnd: anchor.charEnd,
        quoteText: anchor.quoteText,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        tStartMs: segment.startMs,
        tEndMs: segment.endMs,
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
  }, [pending, selectedCodeId, versionId, id, clearSelection, router]);

  const handleFlagQuote = useCallback(async () => {
    if (!pending || !versionId) return;
    setFlagging(true);
    setError(null);
    try {
      const { segment, anchor } = pending;
      await addAnnotation({
        sessionId: id,
        versionId,
        segmentId: segment.id,
        charStart: anchor.charStart,
        charEnd: anchor.charEnd,
        quoteText: anchor.quoteText,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        tStartMs: segment.startMs,
        tEndMs: segment.endMs,
        kind: 'quote',
        codeIds: [],
      });
      clearSelection();
      setRailTab('quotes');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to flag quote.');
    } finally {
      setFlagging(false);
    }
  }, [pending, versionId, id, clearSelection, router]);

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

  const handleCopyQuote = useCallback(async (annotationId: string, quoteText: string) => {
    try {
      await navigator.clipboard.writeText(quoteText);
      setCopiedId(annotationId);
      setTimeout(() => setCopiedId((c) => (c === annotationId ? null : c)), 1500);
    } catch {
      setError('Copy failed — clipboard not available.');
    }
  }, []);

  // --- Episode marks -------------------------------------------------------

  // Mark the selected preset episode at the CURRENT video time. Reads
  // `videoRef.current.currentTime` at click time (so the mark lands wherever the
  // coder has the playhead) and converts to ms. `router.refresh()` re-loads the
  // session's marks server-side.
  const handleMarkEpisode = useCallback(async () => {
    if (!selectedEpisodeId) return;
    const video = videoRef.current;
    const tStartMs = Math.round((video?.currentTime ?? 0) * 1000);
    setMarking(true);
    setError(null);
    try {
      await markSessionEpisode({ sessionId: id, episodeId: selectedEpisodeId, tStartMs });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to mark episode.');
    } finally {
      setMarking(false);
    }
  }, [selectedEpisodeId, id, router]);

  const handleDeleteEpisodeMark = useCallback(async (markId: string) => {
    setBusyEpisodeMarkId(markId);
    setError(null);
    try {
      await deleteSessionEpisode(markId);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete episode mark.');
    } finally {
      setBusyEpisodeMarkId(null);
    }
  }, [router]);

  // Focus a rail annotation (e.g. from clicking its transcript highlight):
  // switch to the right tab and flag it focused. The actual scroll-into-view is
  // an EFFECT keyed on `focusedAnnId` (below), NOT an imperative ref read here —
  // keeping ref access out of any render-reachable callback (react-hooks/refs).
  const focusAnnotation = useCallback((ann: MyAnnotationView) => {
    setRailTab(ann.kind === 'quote' ? 'quotes' : 'codes');
    setFocusedAnnId(ann.id);
  }, []);

  // Scroll the focused rail row into view after the tab switch has rendered it.
  useEffect(() => {
    if (!focusedAnnId) return;
    railRowRefs.current[focusedAnnId]?.scrollIntoView({ block: 'nearest' });
  }, [focusedAnnId, railTab]);

  // --- Derived view helpers ----------------------------------------------

  const filteredCodes = useMemo(() => {
    const q = codeFilter.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter(
      (c) =>
        c.mnemonic.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    );
  }, [codes, codeFilter]);

  // Annotations grouped by segment id → the highlights to render over each
  // segment's text. Only own annotations (own-coding isolation).
  const highlightsBySegment = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    for (const a of myAnnotations) {
      const list = m.get(a.segmentId) ?? [];
      list.push({
        annotationId: a.id,
        charStart: a.charStart,
        charEnd: a.charEnd,
        kind: a.kind,
      });
      m.set(a.segmentId, list);
    }
    return m;
  }, [myAnnotations]);

  // Annotation lookup by id (for resolving a clicked highlight → rail focus).
  const annById = useMemo(() => {
    const m = new Map<string, MyAnnotationView>();
    for (const a of myAnnotations) m.set(a.id, a);
    return m;
  }, [myAnnotations]);

  const quotes = useMemo(
    () => myAnnotations.filter((a) => a.kind === 'quote'),
    [myAnnotations],
  );
  const codeAnnotations = useMemo(
    () => myAnnotations.filter((a) => a.kind !== 'quote'),
    [myAnnotations],
  );

  const canApply = !!pending && !!selectedCodeId && !!versionId && !applying;
  const canFlag = !!pending && !!versionId && !flagging;

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-medium tracking-tight">
            Participant{' '}
            <span className="font-mono text-foreground/50">({pidLabel})</span>
          </h1>
          {compareHref && (
            <Link
              href={compareHref}
              className="rounded border border-foreground/30 px-2 py-1 text-xs text-foreground/70 hover:text-foreground"
              title="Post-hoc, read-only: how every coder coded this session"
            >
              Compare ⇄
            </Link>
          )}
        </div>
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
              {/* Episode marks: pick a preset episode + "Mark here" pins it at
                  the current video time; the list below is the navigable timeline
                  of episode boundaries (click → seek, ✕ → delete). */}
              <section className="rounded border border-foreground/15 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Episode</h2>
                  <Link
                    href="/episodes"
                    className="ml-auto text-xs text-foreground/50 underline hover:text-foreground"
                    title="Manage the codebook's preset episodes"
                  >
                    Manage presets
                  </Link>
                </div>

                {episodes.length === 0 ? (
                  <p className="text-sm text-foreground/50">
                    No preset episodes.{' '}
                    <Link href="/episodes" className="underline hover:text-foreground">
                      Add some
                    </Link>{' '}
                    to mark session phases for navigation.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={selectedEpisodeId}
                      onChange={(e) => setSelectedEpisodeId(e.target.value)}
                      className="min-w-40 rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
                      aria-label="Episode to mark"
                    >
                      <option value="">Select an episode…</option>
                      {episodes.map((ep) => (
                        <option key={ep.id} value={ep.id}>
                          {ep.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleMarkEpisode}
                      disabled={!selectedEpisodeId || marking}
                      title="Mark the selected episode at the current video time"
                      className="rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-40"
                    >
                      {marking ? 'Marking…' : 'Mark here'}
                    </button>
                  </div>
                )}

                {sessionEpisodes.length > 0 && (
                  <ul className="mt-2 divide-y divide-foreground/10">
                    {sessionEpisodes.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center gap-2 py-1.5 text-sm"
                      >
                        <button
                          type="button"
                          onClick={() => seekTo(m.tStartMs)}
                          className="flex-1 text-left hover:underline"
                          title="Seek to this episode"
                        >
                          <span className="font-semibold">{m.episodeName}</span>{' '}
                          <span className="font-mono text-xs text-foreground/50">
                            [{formatTime(m.tStartMs)}]
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteEpisodeMark(m.id)}
                          disabled={busyEpisodeMarkId === m.id}
                          aria-label={`Delete episode mark ${m.episodeName}`}
                          className="text-foreground/40 hover:text-red-500 disabled:opacity-40"
                        >
                          {'✕'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Coding toolbar */}
              <section className="rounded border border-foreground/15 p-3">
                <h2 className="mb-2 text-sm font-semibold">Code or quote a selection</h2>
                {pending ? (
                  <p className="mb-2 text-sm">
                    <span className="rounded bg-foreground/10 px-1 font-mono text-xs">
                      [{pending.anchor.charStart}–{pending.anchor.charEnd}]
                    </span>{' '}
                    “
                    <span className="italic text-foreground/80">
                      {pending.anchor.quoteText.length > 80
                        ? pending.anchor.quoteText.slice(0, 80) + '…'
                        : pending.anchor.quoteText}
                    </span>
                    ”{' '}
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
                    Select text in a transcript segment to code it or flag it as a
                    quote.
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
                  <button
                    type="button"
                    onClick={handleFlagQuote}
                    disabled={!canFlag}
                    title="Flag the selected text as a paper quote (no code)"
                    className="rounded border border-amber-500/60 px-3 py-1 text-sm text-amber-700 hover:bg-amber-500/10 disabled:opacity-40 dark:text-amber-300"
                  >
                    {flagging ? 'Flagging…' : 'Flag quote ❝'}
                  </button>
                </div>
              </section>

              {/* Own-coding rail: ONLY the signed-in coder's annotations, with a
                  Codes / Quotes tab. */}
              <section className="rounded border border-foreground/15 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">My annotations</h2>
                  <div className="ml-auto flex gap-1 text-xs">
                    <button
                      type="button"
                      onClick={() => setRailTab('codes')}
                      aria-pressed={railTab === 'codes'}
                      className={`rounded px-2 py-0.5 ${
                        railTab === 'codes'
                          ? 'bg-foreground text-background'
                          : 'border border-foreground/30 text-foreground/70 hover:text-foreground'
                      }`}
                    >
                      Codes ({codeAnnotations.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setRailTab('quotes')}
                      aria-pressed={railTab === 'quotes'}
                      className={`rounded px-2 py-0.5 ${
                        railTab === 'quotes'
                          ? 'bg-amber-500 text-background'
                          : 'border border-foreground/30 text-foreground/70 hover:text-foreground'
                      }`}
                    >
                      Quotes ({quotes.length})
                    </button>
                  </div>
                </div>

                {railTab === 'codes' ? (
                  codeAnnotations.length === 0 ? (
                    <p className="text-sm text-foreground/50">No coded spans yet.</p>
                  ) : (
                    <ul className="divide-y divide-foreground/10">
                      {codeAnnotations.map((a) => {
                        const codeLabel =
                          a.codes.map((c) => c.mnemonic).join(', ') || '—';
                        return (
                          <li
                            key={a.id}
                            ref={(el) => {
                              railRowRefs.current[a.id] = el;
                            }}
                            className={`flex items-center gap-2 py-1.5 text-sm ${
                              focusedAnnId === a.id ? 'bg-emerald-500/10' : ''
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => seekTo(a.tStartMs)}
                              className="flex-1 text-left hover:underline"
                              title={a.quoteText ?? codeLabel}
                            >
                              <span className="font-mono text-xs text-foreground/50">
                                {formatSpan(a.tStartMs, a.tEndMs)}
                              </span>{' '}
                              <span className="font-semibold">{codeLabel}</span>
                              {a.quoteText && (
                                <span className="ml-1 text-foreground/50">
                                  “{a.quoteText.length > 48
                                    ? a.quoteText.slice(0, 48) + '…'
                                    : a.quoteText}”
                                </span>
                              )}
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
                  )
                ) : quotes.length === 0 ? (
                  <p className="text-sm text-foreground/50">
                    No flagged quotes. Select transcript text and click “Flag
                    quote ❝”.
                  </p>
                ) : (
                  <ul className="divide-y divide-foreground/10">
                    {quotes.map((a) => (
                      <li
                        key={a.id}
                        ref={(el) => {
                          railRowRefs.current[a.id] = el;
                        }}
                        className={`flex items-start gap-2 py-1.5 text-sm ${
                          focusedAnnId === a.id ? 'bg-amber-500/10' : ''
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => seekTo(a.tStartMs)}
                          className="flex-1 text-left"
                          title="Seek to here"
                        >
                          <span className="font-mono text-xs text-amber-700 dark:text-amber-300">
                            [{formatTime(a.tStartMs)}]
                          </span>{' '}
                          <span className="text-foreground/80">
                            “{a.quoteText ?? '(no text)'}”
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopyQuote(a.id, a.quoteText ?? '')
                          }
                          disabled={!a.quoteText}
                          aria-label="Copy quote to clipboard"
                          className="shrink-0 text-foreground/50 hover:text-foreground disabled:opacity-40"
                        >
                          {copiedId === a.id ? '✓' : '⧉'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteAnnotation(a.id)}
                          disabled={busyId === a.id}
                          aria-label="Delete quote"
                          className="shrink-0 text-foreground/40 hover:text-red-500 disabled:opacity-40"
                        >
                          {'✕'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        {/* Right (1/3): scrollable, click-to-seek, text-selectable transcript */}
        <div className="lg:col-span-1">
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
            onMouseUp={codingEnabled ? handleTranscriptMouseUp : undefined}
            className="h-[70vh] overflow-y-auto border border-foreground/15 divide-y divide-foreground/10"
          >
            {segments.length === 0 ? (
              <p className="p-4 text-sm text-foreground/60">No transcript</p>
            ) : (
              segments.map((seg, i) => {
                const active = i === activeIdx;
                const highlights = highlightsBySegment.get(seg.id) ?? [];
                const isAnnotated = codingEnabled && highlights.length > 0;
                return (
                  <div
                    key={seg.id}
                    ref={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    aria-current={active ? 'true' : undefined}
                    className={`flex items-start gap-1 px-2 py-2 text-sm transition ${
                      active ? 'bg-foreground/10' : 'hover:bg-foreground/[0.04]'
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
                    {/* Row body: SELECTABLE text. The whole segment text lives in
                        one `data-seg-idx` element so `resolveSelection` can map a
                        browser Range to char offsets within it. */}
                    <p className="flex-1 select-text text-left">
                      {seg.speaker && (
                        <span className="mr-1.5 font-semibold">{seg.speaker}:</span>
                      )}
                      <span
                        data-seg-idx={i}
                        className="text-foreground/80"
                      >
                        {codingEnabled && highlights.length > 0
                          ? renderHighlightedText(
                              seg.text,
                              highlights,
                              annById,
                              focusAnnotation,
                            )
                          : seg.text}
                      </span>
                    </p>
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

/**
 * Render a segment's text with its annotation char-ranges marked. Splits the
 * text at every highlight boundary (`splitIntoPieces`) and wraps each covered
 * piece in a `<mark>`-style span — emerald for code annotations, amber for
 * quotes. Overlapping ranges layer: a piece under both a code and a quote gets
 * the quote tint (quotes are the rarer, paper-bound signal). Clicking a marked
 * piece focuses its (first) annotation in the rail.
 *
 * Returned as a plain string when there are no highlights would be simpler, but
 * the caller only invokes this when `highlights.length > 0`.
 */
function renderHighlightedText(
  text: string,
  highlights: Highlight[],
  annById: Map<string, MyAnnotationView>,
  onFocus: (ann: MyAnnotationView) => void,
): React.ReactNode {
  const pieces = splitIntoPieces(text, highlights);
  return pieces.map((piece, idx) => {
    if (piece.highlightIds.length === 0) {
      return <span key={idx}>{piece.text}</span>;
    }
    const hasQuote = piece.kinds.includes('quote');
    const firstId = piece.highlightIds[0];
    const ann = annById.get(firstId);
    return (
      <mark
        key={idx}
        onClick={(e) => {
          e.stopPropagation();
          if (ann) onFocus(ann);
        }}
        title={hasQuote ? 'Flagged quote — click to view in rail' : 'Coded — click to view in rail'}
        className={`cursor-pointer rounded-sm px-px ${
          hasQuote
            ? 'bg-amber-300/50 text-foreground dark:bg-amber-400/30'
            : 'bg-emerald-300/50 text-foreground dark:bg-emerald-400/30'
        }`}
      >
        {piece.text}
      </mark>
    );
  });
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ensureCleanedVersion,
  getSessionSegments,
  updateSegmentText,
  type CloudSegment,
  type SessionVersion,
} from '@/app/actions/sessions';
import {
  addAnnotation,
  deleteAnnotation,
  listMyAnnotationsForVersion,
  addAnnotationComment,
  listAnnotationComments,
  resolveAnnotationComment,
  deleteAnnotationComment,
  type MyAnnotationView,
  type AnnotationCommentView,
} from '@/app/actions/annotations';
import {
  markSessionEpisode,
  deleteSessionEpisode,
  type SessionEpisodeView,
} from '@/app/actions/episodes';
import type { ObservationView } from '@/app/actions/observations';
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
 * The display label for an observation marker/row. A flag tap uses its flag's
 * label; a flag whose type was deleted shows the action's '(deleted flag)'
 * sentinel; a bare note (no flag) reads "Note". Kept separate from the body
 * (the free-text comment), which renders alongside it.
 */
function observationLabel(o: { flagLabel: string | null }): string {
  return o.flagLabel ?? 'Note';
}

/**
 * The marker/chip color for an observation. Uses the flag's swatch color when
 * present; falls back to a neutral foreground tint for bare notes or
 * colorless/deleted flags, so a marker is always visible on the rail.
 */
function observationColor(o: { color: string | null }): string {
  return o.color ?? 'var(--foreground)';
}

/**
 * Format a comment's ISO `created_at` as a short, locale-aware `MMM d, HH:mm`.
 * Falls back to the raw string if it can't be parsed (defensive — the value
 * comes from the DB, but a bad value should never throw in render).
 */
function formatCommentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
 *
 * Live-flag review markers (live co-observation, Task 5): the participant's live
 * `cb_observations` are placed on a time rail under the video at
 * `createdAt − recordingStartedAt` (the recording anchor) and listed, in time
 * order, in a "Flags on timeline" rail — flag swatch/label + note + `[mm:ss]`,
 * each a `seekTo(offset)` button (reusing the same seek mechanism as transcript
 * clicks and episode marks). Pre-record offsets clamp to 0 (mirroring the
 * auto-episode clamp); when the recording was never anchored
 * (`recordingStartedAt` null) the markers can't be placed, so an "anchor not
 * set" hint renders instead. Read-only here — flags are logged live on
 * `/sessions/live`.
 */
export default function SessionPlayer({
  id,
  pidLabel,
  segments: initialSegments,
  durationMs,
  codingEnabled = false,
  versionId: originalVersionId = null,
  versions = [],
  codes = [],
  myAnnotations: initialAnnotations = [],
  comments: initialComments = {},
  myUid = null,
  episodes = [],
  sessionEpisodes = [],
  observations = [],
  recordingStartedAt = null,
  compareHref = null,
}: {
  id: string;
  pidLabel: string;
  /** The ORIGINAL version's segments (the default tab the page renders). */
  segments: CloudSegment[];
  durationMs: number;
  /** Render the coding toolbar + own-coding rail. */
  codingEnabled?: boolean;
  /** The original transcript version id annotations anchor to (version_id). */
  versionId?: string | null;
  /** All of the session's transcript versions (the Original/Cleaned tab set). */
  versions?: SessionVersion[];
  codes?: CodeOption[];
  /** The signed-in coder's OWN annotations for the ORIGINAL version (initial). */
  myAnnotations?: MyAnnotationView[];
  /**
   * Per-excerpt comment threads, grouped by annotation id (#17/#18). The page
   * loads every visible annotation's comments in one call; the player opens the
   * thread when its highlight is clicked. Tracks the active version's
   * annotations (re-fetched client-side on a comment mutation / version switch).
   */
  comments?: Record<string, AnnotationCommentView[]>;
  /** The signed-in coder's auth uid — used to scope realtime sync to own rows. */
  myUid?: string | null;
  /** The codebook's preset episodes the coder can mark at a timecode. */
  episodes?: EpisodeOption[];
  /** This session's episode marks (boundaries to navigate / resume by). */
  sessionEpisodes?: SessionEpisodeView[];
  /**
   * The live co-observation flags logged for this session's participant (Task 5).
   * Each renders as a clickable marker on the time rail at
   * `createdAt − recordingStartedAt`, and in the Flags rail. Read-only here —
   * observations are created live on `/sessions/live`.
   */
  observations?: ObservationView[];
  /**
   * `cb_sessions.recording_started_at` (ISO) — the t=0 anchor that turns an
   * observation's absolute `createdAt` into a video offset. `null` when the
   * recording was never anchored: with no anchor the player can't place any
   * marker, so it renders an "anchor not set" hint instead.
   */
  recordingStartedAt?: string | null;
  /** Link to the post-hoc, read-only Compare tab (own-coding stays here). */
  compareHref?: string | null;
}) {
  const router = useRouter();

  // --- Transcript layers (feature #20): original (verbatim) vs cleaned --------
  //
  // The page renders the ORIGINAL version (its segments + own annotations) into
  // the props above. The active version may then be switched to CLEANED, which
  // loads that version's segments + annotations CLIENT-SIDE (so we don't reload
  // the whole server tree, which is anchored to the original). `versionId` is the
  // active version id annotations anchor to; `segments`/`myAnnotations` follow it.
  const cleanedVersionFromList = versions.find((v) => v.kind === 'cleaned') ?? null;

  // The active tab: 'original' (verbatim, read-only) or 'cleaned' (editable).
  const [activeTab, setActiveTab] = useState<'original' | 'cleaned'>('original');

  // The active version id annotations anchor to. Starts at the original; tracks
  // the active tab (set to the cleaned id once that version is loaded/created).
  const [versionId, setVersionId] = useState<string | null>(originalVersionId);
  // The resolved cleaned version id once known (from the list, or after create).
  const [cleanedVersionId, setCleanedVersionId] = useState<string | null>(
    cleanedVersionFromList?.id ?? null,
  );

  // The segments + own annotations for the ACTIVE version. Initialized to the
  // original's (the props), swapped when the active tab changes.
  const [segments, setSegments] = useState<CloudSegment[]>(initialSegments);
  const [myAnnotations, setMyAnnotations] =
    useState<MyAnnotationView[]>(initialAnnotations);

  // Per-excerpt comment threads for the ACTIVE version's annotations (#17/#18),
  // grouped by annotation id. Seeded from the server (the original's threads),
  // re-fetched client-side after a comment mutation or a version switch.
  const [comments, setComments] =
    useState<Record<string, AnnotationCommentView[]>>(initialComments);

  // Cache the original version's loaded segments/annotations so switching BACK to
  // the original tab is instant and never re-fetches (the original is immutable).
  const originalSegmentsRef = useRef<CloudSegment[]>(initialSegments);

  // Version-switch / cleaning in-flight + error surfaces.
  const [versionBusy, setVersionBusy] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);

  // Whether the cleaned tab is in edit (data-cleaning) mode. Original is NEVER
  // editable — this only applies on the cleaned tab.
  const [editing, setEditing] = useState(false);

  const isCleanedActive = activeTab === 'cleaned';
  const isVerbatim = activeTab === 'original';

  // Reload the comment threads for a set of annotation ids (the active version's
  // visible annotations) in ONE call. Used after a comment mutation and whenever
  // the active version's annotations are re-fetched. Tolerant of an empty id set
  // (clears the map). Surfaces failures into the comment-panel error, not the
  // global one.
  const reloadComments = useCallback(async (annotationIds: string[]) => {
    if (annotationIds.length === 0) {
      setComments({});
      return;
    }
    const next = await listAnnotationComments(annotationIds);
    setComments(next);
  }, []);

  // Realtime live-sync only makes sense for the ORIGINAL version (the server tree
  // the page renders). On the cleaned tab a refresh would reload the original
  // props and desync the displayed segments, so we re-fetch the active version's
  // annotations in place instead. We also re-pull the comment threads for the
  // re-fetched annotations so per-excerpt threads stay in sync.
  const refreshActiveAnnotations = useCallback(async () => {
    if (!versionId) return;
    try {
      const next = await listMyAnnotationsForVersion(id, versionId);
      setMyAnnotations(next);
      await reloadComments(next.map((a) => a.id));
    } catch (e) {
      setVersionError(
        e instanceof Error ? e.message : 'Failed to refresh annotations.',
      );
    }
  }, [id, versionId, reloadComments]);

  useRealtimeAnnotations({
    sessionId: id,
    myUid,
    onChange: () => {
      // Original tab: re-run the server component (canonical path). Cleaned tab:
      // re-fetch the active version's annotations in place (the server tree is
      // anchored to the original, so a full refresh would desync the view).
      if (activeTab === 'original') router.refresh();
      else void refreshActiveAnnotations();
    },
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

  // --- Per-excerpt comments (Google-Docs style, #17/#18) ------------------
  // The annotation whose comment thread is OPEN (clicking its highlight opens
  // it). `null` = no thread open. The popover renders the excerpt + codes +
  // thread + an add-comment input for THIS annotation.
  const [openCommentAnnId, setOpenCommentAnnId] = useState<string | null>(null);
  // The add-comment draft for the OPEN thread (existing annotation).
  const [commentDraft, setCommentDraft] = useState('');
  // The comment draft for a FRESH selection (the coding-toolbar "Comment"
  // affordance), kept separate so the two inputs never share text.
  const [selectionCommentDraft, setSelectionCommentDraft] = useState('');
  // Comment mutation in-flight (disables the compose controls).
  const [commentBusy, setCommentBusy] = useState(false);
  // A comment being resolved/deleted (per-row busy state in the thread).
  const [commentRowBusyId, setCommentRowBusyId] = useState<string | null>(null);
  // Comment-panel-scoped error (kept separate from the global coding error).
  const [commentError, setCommentError] = useState<string | null>(null);

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

  // --- Version switching (Original / Cleaned tabs) ------------------------

  // Load one version into the active view: its segments + the active coder's own
  // annotations for THAT version (version-scoped, so highlights anchor to the
  // loaded text). Clears any pending selection (its segment index would be stale
  // against the newly loaded segments). On failure the active tab is left as the
  // caller set it but the error is surfaced.
  const loadVersion = useCallback(
    async (targetVersionId: string) => {
      setVersionBusy(true);
      setVersionError(null);
      try {
        const [segs, anns] = await Promise.all([
          getSessionSegments(id, targetVersionId),
          listMyAnnotationsForVersion(id, targetVersionId),
        ]);
        setVersionId(targetVersionId);
        setSegments(segs);
        setMyAnnotations(anns);
        setTextSel(null);
        setActiveIdx(-1);
        // Load this version's annotations' comment threads; close any open one
        // (its annotation belongs to the version we just left).
        setOpenCommentAnnId(null);
        await reloadComments(anns.map((a) => a.id));
      } catch (e) {
        setVersionError(
          e instanceof Error ? e.message : 'Failed to load transcript version.',
        );
      } finally {
        setVersionBusy(false);
      }
    },
    [id, reloadComments],
  );

  // Switch to the ORIGINAL (verbatim) tab. The original is immutable, so we
  // restore its cached segments + re-scope annotations to it without re-reading
  // the segments. Leaving edit mode is implicit (original is never editable).
  const handleSelectOriginal = useCallback(async () => {
    if (activeTab === 'original') return;
    setActiveTab('original');
    setEditing(false);
    setVersionId(originalVersionId);
    setSegments(originalSegmentsRef.current);
    setTextSel(null);
    setActiveIdx(-1);
    setOpenCommentAnnId(null);
    if (originalVersionId) {
      setVersionBusy(true);
      setVersionError(null);
      try {
        const anns = await listMyAnnotationsForVersion(id, originalVersionId);
        setMyAnnotations(anns);
        await reloadComments(anns.map((a) => a.id));
      } catch (e) {
        setVersionError(
          e instanceof Error ? e.message : 'Failed to load original annotations.',
        );
      } finally {
        setVersionBusy(false);
      }
    } else {
      setMyAnnotations([]);
      setComments({});
    }
  }, [activeTab, id, originalVersionId, reloadComments]);

  // Switch to the CLEANED tab. If a cleaned version already exists, load it;
  // otherwise we render the "Create cleaned copy" affordance (no version yet).
  const handleSelectCleaned = useCallback(async () => {
    if (activeTab === 'cleaned') return;
    setActiveTab('cleaned');
    setEditing(false);
    if (cleanedVersionId) {
      await loadVersion(cleanedVersionId);
    } else {
      // No cleaned version yet: show the create affordance, empty transcript.
      setVersionId(null);
      setSegments([]);
      setMyAnnotations([]);
      setComments({});
      setOpenCommentAnnId(null);
      setTextSel(null);
      setActiveIdx(-1);
    }
  }, [activeTab, cleanedVersionId, loadVersion]);

  // Create the cleaned copy (idempotent server-side) and load it. Called from the
  // "Create cleaned copy" button on the cleaned tab when none exists yet.
  const handleCreateCleaned = useCallback(async () => {
    setVersionBusy(true);
    setVersionError(null);
    try {
      const newId = await ensureCleanedVersion(id);
      setCleanedVersionId(newId);
      await loadVersion(newId);
    } catch (e) {
      setVersionError(
        e instanceof Error ? e.message : 'Failed to create the cleaned copy.',
      );
      setVersionBusy(false);
    }
  }, [id, loadVersion]);

  // --- Data cleaning: edit a cleaned segment's text ------------------------

  // Commit a cleaned segment's edited text. Optimistic: update local state
  // immediately, then persist (`updateSegmentText`, server-guarded to cleaned
  // versions only). On failure surface the error and re-fetch the version's
  // segments to undo the optimistic edit. No-op when the text is unchanged.
  const handleSegmentTextCommit = useCallback(
    async (segmentId: string, nextText: string) => {
      const current = segments.find((s) => s.id === segmentId);
      if (!current) return;
      const trimmed = nextText;
      if (trimmed === current.text) return;
      if (trimmed.trim() === '') {
        // Blanking a segment is never a valid cleaning; revert the field.
        setSegments((prev) => prev.map((s) => ({ ...s })));
        setVersionError('A cleaned segment cannot be blank.');
        return;
      }
      // Optimistic local update.
      setSegments((prev) =>
        prev.map((s) => (s.id === segmentId ? { ...s, text: trimmed } : s)),
      );
      setVersionError(null);
      try {
        await updateSegmentText(segmentId, trimmed);
      } catch (e) {
        setVersionError(
          e instanceof Error ? e.message : 'Failed to save the cleaned text.',
        );
        // Revert to the persisted segments for this version.
        if (versionId) {
          try {
            const segs = await getSessionSegments(id, versionId);
            setSegments(segs);
          } catch {
            // Leave the optimistic value if even the re-read fails.
          }
        }
      }
    },
    [segments, id, versionId],
  );

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

  // After a coding mutation, re-load the OWN-annotations rail for the ACTIVE
  // version. On the original tab the server tree IS the active view, so a
  // `router.refresh()` is canonical; on the cleaned tab the server props are
  // anchored to the original, so we re-fetch the active version's annotations in
  // place to avoid desyncing the displayed (cleaned) segments.
  const afterAnnotationMutation = useCallback(async () => {
    if (activeTab === 'original') {
      router.refresh();
    } else {
      await refreshActiveAnnotations();
    }
  }, [activeTab, router, refreshActiveAnnotations]);

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
      await afterAnnotationMutation();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply code.');
    } finally {
      setApplying(false);
    }
  }, [pending, selectedCodeId, versionId, id, clearSelection, afterAnnotationMutation]);

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
      await afterAnnotationMutation();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to flag quote.');
    } finally {
      setFlagging(false);
    }
  }, [pending, versionId, id, clearSelection, afterAnnotationMutation]);

  const handleDeleteAnnotation = useCallback(async (annotationId: string) => {
    setBusyId(annotationId);
    setError(null);
    try {
      await deleteAnnotation(annotationId);
      // Close the comment thread if it belonged to the deleted excerpt (its
      // comments cascade away with the annotation).
      setOpenCommentAnnId((cur) => (cur === annotationId ? null : cur));
      await afterAnnotationMutation();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete annotation.');
    } finally {
      setBusyId(null);
    }
  }, [afterAnnotationMutation]);

  const handleCopyQuote = useCallback(async (annotationId: string, quoteText: string) => {
    try {
      await navigator.clipboard.writeText(quoteText);
      setCopiedId(annotationId);
      setTimeout(() => setCopiedId((c) => (c === annotationId ? null : c)), 1500);
    } catch {
      setError('Copy failed — clipboard not available.');
    }
  }, []);

  // --- Per-excerpt comments (#17/#18) -------------------------------------

  // Open (or re-open) the comment thread for an annotation. Resets the draft and
  // any prior comment error so the popover opens clean. Refreshes the thread for
  // this annotation so it reflects others' comments since the last load.
  const openCommentThread = useCallback(
    async (annotationId: string) => {
      setOpenCommentAnnId(annotationId);
      setCommentDraft('');
      setCommentError(null);
      try {
        const grouped = await listAnnotationComments([annotationId]);
        setComments((prev) => ({ ...prev, [annotationId]: grouped[annotationId] ?? [] }));
      } catch (e) {
        setCommentError(
          e instanceof Error ? e.message : 'Failed to load comments.',
        );
      }
    },
    [],
  );

  // Add a comment to the OPEN thread (an existing annotation). Re-pulls that
  // annotation's thread on success so the new comment (with the server-resolved
  // author name + time) appears. Also re-runs the annotation refresh so the
  // mark's comment-count indicator updates.
  const handleAddComment = useCallback(async () => {
    if (!openCommentAnnId || commentDraft.trim() === '') return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      await addAnnotationComment(openCommentAnnId, commentDraft.trim());
      setCommentDraft('');
      const grouped = await listAnnotationComments([openCommentAnnId]);
      setComments((prev) => ({
        ...prev,
        [openCommentAnnId]: grouped[openCommentAnnId] ?? [],
      }));
      // Refresh annotations so the comment-count indicator on the mark updates.
      await afterAnnotationMutation();
    } catch (e) {
      setCommentError(e instanceof Error ? e.message : 'Failed to add comment.');
    } finally {
      setCommentBusy(false);
    }
  }, [openCommentAnnId, commentDraft, afterAnnotationMutation]);

  // Comment on a FRESH selection that isn't yet an annotation: create a
  // kind:'quote' annotation as the ANCHOR, then post the first comment on it,
  // then open its thread. This makes "comment on arbitrary text" work without
  // first coding it (Google-Docs comment-on-selection). Reuses addAnnotation +
  // addAnnotationComment so the anchor is an ordinary highlight.
  const handleCommentOnSelection = useCallback(async () => {
    if (!pending || !versionId || selectionCommentDraft.trim() === '') return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      const { segment, anchor } = pending;
      const ann = await addAnnotation({
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
      await addAnnotationComment(ann.id, selectionCommentDraft.trim());
      setSelectionCommentDraft('');
      clearSelection();
      // Reload the active version's annotations (so the new anchor + its
      // comment-count appear), then open the new thread.
      await afterAnnotationMutation();
      await openCommentThread(ann.id);
    } catch (e) {
      setCommentError(
        e instanceof Error ? e.message : 'Failed to comment on selection.',
      );
    } finally {
      setCommentBusy(false);
    }
  }, [
    pending,
    versionId,
    selectionCommentDraft,
    id,
    clearSelection,
    afterAnnotationMutation,
    openCommentThread,
  ]);

  // Resolve / re-open a comment in the open thread, then re-pull the thread.
  const handleResolveComment = useCallback(
    async (commentId: string, resolved: boolean) => {
      if (!openCommentAnnId) return;
      setCommentRowBusyId(commentId);
      setCommentError(null);
      try {
        await resolveAnnotationComment(commentId, resolved);
        const grouped = await listAnnotationComments([openCommentAnnId]);
        setComments((prev) => ({
          ...prev,
          [openCommentAnnId]: grouped[openCommentAnnId] ?? [],
        }));
      } catch (e) {
        setCommentError(
          e instanceof Error ? e.message : 'Failed to update comment.',
        );
      } finally {
        setCommentRowBusyId(null);
      }
    },
    [openCommentAnnId],
  );

  // Delete a comment from the open thread, then re-pull + refresh the count.
  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      if (!openCommentAnnId) return;
      setCommentRowBusyId(commentId);
      setCommentError(null);
      try {
        await deleteAnnotationComment(commentId);
        const grouped = await listAnnotationComments([openCommentAnnId]);
        setComments((prev) => ({
          ...prev,
          [openCommentAnnId]: grouped[openCommentAnnId] ?? [],
        }));
        await afterAnnotationMutation();
      } catch (e) {
        setCommentError(
          e instanceof Error ? e.message : 'Failed to delete comment.',
        );
      } finally {
        setCommentRowBusyId(null);
      }
    },
    [openCommentAnnId, afterAnnotationMutation],
  );

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

  // Clicking a transcript highlight (a `<mark>`) is the Google-Docs
  // "click-the-highlight-to-comment" affordance: it OPENS the excerpt's comment
  // thread AND focuses its rail row. Opening the thread re-pulls this
  // annotation's comments (see openCommentThread). The scroll-into-view is an
  // EFFECT keyed on `focusedAnnId` (below), NOT an imperative ref read here —
  // keeping ref access out of any render-reachable callback (react-hooks/refs).
  const focusAnnotation = useCallback(
    (ann: MyAnnotationView) => {
      setRailTab(ann.kind === 'quote' ? 'quotes' : 'codes');
      setFocusedAnnId(ann.id);
      void openCommentThread(ann.id);
    },
    [openCommentThread],
  );

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

  // Annotation ids that carry ≥1 comment → render a thread indicator on their
  // mark. Derived from BOTH the loaded thread map (freshest) and the
  // annotation's own `commentCount` (server-rendered), so the dot shows even
  // before a thread has been individually loaded.
  const commentedAnnIds = useMemo(() => {
    const s = new Set<string>();
    for (const a of myAnnotations) if (a.commentCount > 0) s.add(a.id);
    for (const [annId, list] of Object.entries(comments)) {
      if (list.length > 0) s.add(annId);
      else s.delete(annId); // a thread emptied by deletes drops its dot
    }
    return s;
  }, [myAnnotations, comments]);

  // --- Live co-observation review markers (Task 5) ------------------------
  //
  // Each observation's video offset is `createdAt − recordingStartedAt`. The
  // anchor is the SAME one Task 4 wrote (the task `module_start + 2000ms`), so a
  // flag tapped live lands on the moment in the recording. Computed once here so
  // the time-rail markers and the Flags rail share one ordered list.
  //
  // recordingStartedAt null → no anchor yet: we can't place any marker, so this
  // is empty and the UI shows an "anchor not set" hint instead (handled below).
  // Offsets < 0 (a flag logged before record start, e.g. during onboarding) are
  // CLAMPED to 0 — consistent with Task 4's `t_start_ms: Math.max(0, …)` clamp
  // for auto-episodes — so an early flag pins to the recording's start rather
  // than being dropped or producing a negative seek.
  const anchorMs = useMemo(() => {
    if (!recordingStartedAt) return null;
    const ms = Date.parse(recordingStartedAt);
    return Number.isNaN(ms) ? null : ms;
  }, [recordingStartedAt]);

  const flagMarkers = useMemo(() => {
    if (anchorMs === null) return [];
    return observations
      .map((o) => {
        const createdMs = Date.parse(o.createdAt);
        if (Number.isNaN(createdMs)) return null;
        // Clamp pre-record flags to t=0 (mirror the auto-episode clamp).
        const offsetMs = Math.max(0, createdMs - anchorMs);
        return { obs: o, offsetMs };
      })
      .filter((m): m is { obs: ObservationView; offsetMs: number } => m !== null)
      .sort((a, b) => a.offsetMs - b.offsetMs);
  }, [observations, anchorMs]);

  // The denominator for placing a marker along the rail: the video duration, or
  // the latest marker offset if that runs past the known duration (defensive — a
  // flag could be logged after the recording's metadata duration in odd data).
  // Guarded to ≥1 so a zero-duration session never divides by zero.
  const railSpanMs = useMemo(() => {
    const lastOffset = flagMarkers.length
      ? flagMarkers[flagMarkers.length - 1].offsetMs
      : 0;
    return Math.max(1, durationMs, lastOffset);
  }, [flagMarkers, durationMs]);

  // The annotation whose comment thread is open + its loaded comments, for the
  // popover. `null` when nothing is open or the annotation is no longer present
  // (e.g. deleted / version switched out from under the open thread).
  const openCommentAnn = openCommentAnnId ? annById.get(openCommentAnnId) ?? null : null;
  const openThread = openCommentAnnId ? comments[openCommentAnnId] ?? [] : [];

  const canApply = !!pending && !!selectedCodeId && !!versionId && !applying;
  const canFlag = !!pending && !!versionId && !flagging;
  // "Comment" on a fresh selection needs a brushed selection + a draft.
  const canCommentOnSelection =
    !!pending && !!versionId && selectionCommentDraft.trim() !== '' && !commentBusy;

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

          {/* Live-flag marker rail (Task 5): the participant's live observations
              placed along an absolute time rail at `createdAt − recording start`.
              Each marker is a button → seekTo(offset); its color is the flag's
              swatch; its title shows the label + note. Read-only (flags are
              created live on /sessions/live). When the recording was never
              anchored we can't place anything, so we show a hint instead. */}
          {observations.length > 0 && (
            <section
              aria-label="Live flags on the timeline"
              className="rounded border border-foreground/15 p-3"
            >
              <h2 className="mb-2 text-sm font-semibold">
                Flags on timeline
                <span className="ml-1 font-normal text-foreground/40">
                  · {observations.length} live
                  {observations.length === 1 ? '' : ''} observation
                  {observations.length === 1 ? '' : 's'}
                </span>
              </h2>
              {anchorMs === null ? (
                <p className="text-sm text-foreground/50">
                  Recording anchor not set — once this recording is anchored to
                  the participant&apos;s event clock, the{' '}
                  {observations.length} logged flag
                  {observations.length === 1 ? '' : 's'} will appear here at their
                  video offsets.
                </p>
              ) : (
                <div
                  className="relative h-7 w-full rounded bg-foreground/[0.06]"
                  role="group"
                  aria-label="Flag markers"
                >
                  {flagMarkers.map(({ obs, offsetMs }) => {
                    const leftPct = Math.min(
                      100,
                      (offsetMs / railSpanMs) * 100,
                    );
                    const label = observationLabel(obs);
                    return (
                      <button
                        key={obs.id}
                        type="button"
                        onClick={() => seekTo(offsetMs)}
                        title={`[${formatTime(offsetMs)}] ${label}${
                          obs.body ? ` — ${obs.body}` : ''
                        }`}
                        aria-label={`Seek to flag ${label} at ${formatTime(
                          offsetMs,
                        )}`}
                        style={{
                          left: `${leftPct}%`,
                          backgroundColor: observationColor(obs),
                        }}
                        className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background/40 hover:h-5 hover:w-2"
                      />
                    );
                  })}
                </div>
              )}

              {/* Flags rail list: the same observations in time order — flag chip
                  (swatch + label) + note + [mm:ss], each a seek button. Mirrors
                  the episode list / Quotes rail affordances. Only meaningful with
                  an anchor (otherwise there are no offsets to jump to). */}
              {anchorMs !== null && flagMarkers.length > 0 && (
                <ul className="mt-3 divide-y divide-foreground/10">
                  {flagMarkers.map(({ obs, offsetMs }) => {
                    const label = observationLabel(obs);
                    return (
                      <li
                        key={obs.id}
                        className="flex items-start gap-2 py-1.5 text-sm"
                      >
                        <button
                          type="button"
                          onClick={() => seekTo(offsetMs)}
                          className="flex flex-1 items-start gap-2 text-left hover:underline"
                          title="Seek to this flag"
                        >
                          <span
                            aria-hidden
                            style={{ backgroundColor: observationColor(obs) }}
                            className="mt-1 inline-block h-3 w-3 shrink-0 rounded-sm border border-foreground/20"
                          />
                          <span className="flex-1">
                            <span className="font-semibold">{label}</span>
                            {obs.body && (
                              <span className="text-foreground/70">
                                {' — '}
                                {obs.body}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 font-mono text-xs text-foreground/50">
                            [{formatTime(offsetMs)}]
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

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

                {/* Comment on a fresh selection (Google-Docs "comment on
                    selection"): creates a quote anchor + the first comment, then
                    opens its thread. Works on arbitrary text without coding it.
                    Only meaningful once text is brushed. */}
                {pending && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-foreground/10 pt-2">
                    <input
                      type="text"
                      value={selectionCommentDraft}
                      onChange={(e) => setSelectionCommentDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && canCommentOnSelection) {
                          e.preventDefault();
                          void handleCommentOnSelection();
                        }
                      }}
                      placeholder="Comment on this selection…"
                      className="min-w-48 flex-1 rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
                      aria-label="Comment on selection"
                    />
                    <button
                      type="button"
                      onClick={handleCommentOnSelection}
                      disabled={!canCommentOnSelection}
                      title="Comment on the selected text (creates a commentable excerpt)"
                      className="rounded border border-sky-500/60 px-3 py-1 text-sm text-sky-700 hover:bg-sky-500/10 disabled:opacity-40 dark:text-sky-300"
                    >
                      {commentBusy ? 'Commenting…' : 'Comment 💬'}
                    </button>
                  </div>
                )}
              </section>

              {/* Per-excerpt comment thread (Google-Docs style, #17/#18): opens
                  when a highlight is clicked. Shows the quoted excerpt + its
                  code(s) + the comment thread + an add-comment input. */}
              {openCommentAnn && (
                <section className="rounded border border-sky-500/40 bg-sky-500/[0.03] p-3">
                  <div className="mb-2 flex items-start gap-2">
                    <h2 className="text-sm font-semibold">
                      Comments
                      <span className="ml-1 font-normal text-foreground/40">
                        on excerpt
                      </span>
                    </h2>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenCommentAnnId(null);
                        setCommentError(null);
                        setCommentDraft('');
                      }}
                      aria-label="Close comments"
                      className="ml-auto text-foreground/40 hover:text-foreground"
                    >
                      {'✕'}
                    </button>
                  </div>

                  {/* The anchored excerpt + its codes (the "what you're
                      commenting on" context, like a Docs comment card header). */}
                  <div className="mb-2 rounded border border-foreground/10 bg-background/40 px-2 py-1.5 text-sm">
                    <button
                      type="button"
                      onClick={() => seekTo(openCommentAnn.tStartMs)}
                      className="font-mono text-xs text-foreground/50 hover:underline"
                      title="Seek to here"
                    >
                      [{formatTime(openCommentAnn.tStartMs)}]
                    </button>{' '}
                    <span className="italic text-foreground/80">
                      “{openCommentAnn.quoteText ?? '(whole segment)'}”
                    </span>
                    {openCommentAnn.codes.length > 0 && (
                      <span className="ml-1 text-xs text-emerald-700 dark:text-emerald-300">
                        · {openCommentAnn.codes.map((c) => c.mnemonic).join(', ')}
                      </span>
                    )}
                  </div>

                  {commentError && (
                    <p className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300">
                      {commentError}
                    </p>
                  )}

                  {/* The thread. */}
                  {openThread.length === 0 ? (
                    <p className="mb-2 text-sm text-foreground/50">
                      No comments yet. Start the thread below.
                    </p>
                  ) : (
                    <ul className="mb-2 divide-y divide-foreground/10">
                      {openThread.map((c) => (
                        <li key={c.id} className="py-1.5 text-sm">
                          <div className="flex items-baseline gap-2">
                            <span className="font-semibold">{c.authorName}</span>
                            <span className="font-mono text-xs text-foreground/40">
                              {formatCommentTime(c.createdAt)}
                            </span>
                            {c.resolved && (
                              <span className="rounded bg-emerald-500/15 px-1 text-xs text-emerald-700 dark:text-emerald-300">
                                resolved
                              </span>
                            )}
                            <span className="ml-auto flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleResolveComment(c.id, !c.resolved)}
                                disabled={commentRowBusyId === c.id}
                                className="text-xs text-foreground/50 underline hover:text-foreground disabled:opacity-40"
                                title={c.resolved ? 'Re-open this comment' : 'Mark resolved'}
                              >
                                {c.resolved ? 'Re-open' : 'Resolve'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteComment(c.id)}
                                disabled={commentRowBusyId === c.id}
                                aria-label="Delete comment"
                                className="text-foreground/40 hover:text-red-500 disabled:opacity-40"
                              >
                                {'✕'}
                              </button>
                            </span>
                          </div>
                          <p
                            className={`mt-0.5 whitespace-pre-wrap text-foreground/80 ${
                              c.resolved ? 'line-through opacity-60' : ''
                            }`}
                          >
                            {c.body}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Add a comment to this thread. */}
                  <div className="flex items-start gap-2">
                    <textarea
                      value={commentDraft}
                      onChange={(e) => setCommentDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          if (commentDraft.trim() !== '' && !commentBusy) {
                            void handleAddComment();
                          }
                        }
                      }}
                      placeholder="Add a comment… (⌘/Ctrl+Enter to send)"
                      rows={2}
                      className="flex-1 resize-none rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
                      aria-label="Add a comment"
                    />
                    <button
                      type="button"
                      onClick={handleAddComment}
                      disabled={commentDraft.trim() === '' || commentBusy}
                      className="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-40"
                    >
                      {commentBusy ? 'Saving…' : 'Comment'}
                    </button>
                  </div>
                </section>
              )}

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

        {/* Right (1/3): version tabs + scrollable, click-to-seek transcript */}
        <div className="lg:col-span-1">
          {/* Transcript-layer tabs (feature #20): Original (verbatim) is
              read-only; Cleaned is an editable copy for navigation/quoting. */}
          <div
            role="tablist"
            aria-label="Transcript version"
            className="mb-2 flex gap-1 text-xs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'original'}
              onClick={handleSelectOriginal}
              disabled={versionBusy}
              title="The verbatim ASR transcript (read-only — disfluencies are data)"
              className={`rounded px-2 py-1 disabled:opacity-50 ${
                activeTab === 'original'
                  ? 'bg-foreground text-background'
                  : 'border border-foreground/30 text-foreground/70 hover:text-foreground'
              }`}
            >
              Original (verbatim)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'cleaned'}
              onClick={handleSelectCleaned}
              disabled={versionBusy}
              title="A readable copy you can edit for navigation and quoting"
              className={`rounded px-2 py-1 disabled:opacity-50 ${
                activeTab === 'cleaned'
                  ? 'bg-foreground text-background'
                  : 'border border-foreground/30 text-foreground/70 hover:text-foreground'
              }`}
            >
              Cleaned
            </button>
          </div>

          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">
              Transcript
              {isVerbatim ? (
                <span className="ml-1 font-normal text-foreground/40">
                  · verbatim, read-only
                </span>
              ) : (
                <span className="ml-1 font-normal text-foreground/40">· cleaned</span>
              )}
            </h2>
            <div className="flex items-center gap-1">
              {/* Edit toggle: ONLY on the cleaned tab with a loaded version.
                  Original is verbatim and never editable. */}
              {isCleanedActive && versionId && (
                <button
                  type="button"
                  onClick={() => setEditing((e) => !e)}
                  aria-pressed={editing}
                  title={
                    editing
                      ? 'Stop editing the cleaned transcript'
                      : 'Edit the cleaned transcript text'
                  }
                  className={`rounded border px-2 py-1 text-xs ${
                    editing
                      ? 'border-emerald-600 bg-emerald-600 text-background'
                      : 'border-foreground/30 text-foreground/70 hover:text-foreground'
                  }`}
                >
                  {editing ? 'Done' : 'Edit'}
                </button>
              )}
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
          </div>

          {versionError && (
            <p className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300">
              {versionError}
            </p>
          )}

          {/* Cleaned tab with no cleaned version yet: offer to create one. */}
          {isCleanedActive && !versionId ? (
            <div className="rounded border border-foreground/15 p-4 text-sm text-foreground/70">
              <p className="mb-3">
                No cleaned copy exists yet. Create one to get a readable,
                editable transcript for navigation and quoting. The original
                verbatim transcript stays untouched.
              </p>
              <button
                type="button"
                onClick={handleCreateCleaned}
                disabled={versionBusy}
                className="rounded bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50"
              >
                {versionBusy ? 'Creating…' : 'Create cleaned copy'}
              </button>
            </div>
          ) : (
            <div
              ref={transcriptRef}
              onMouseUp={
                codingEnabled && !editing ? handleTranscriptMouseUp : undefined
              }
              className="h-[70vh] overflow-y-auto border border-foreground/15 divide-y divide-foreground/10"
            >
              {versionBusy ? (
                <p className="p-4 text-sm text-foreground/60">Loading…</p>
              ) : segments.length === 0 ? (
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
                      {/* Row body. In CLEANING mode (cleaned tab + Edit on) each
                          segment is a textarea committed on blur; otherwise the
                          text is selectable for coding (one `data-seg-idx`
                          element so `resolveSelection` maps a Range to offsets). */}
                      {isCleanedActive && editing ? (
                        <div className="flex-1">
                          {seg.speaker && (
                            <span className="mb-0.5 block text-xs font-semibold text-foreground/60">
                              {seg.speaker}:
                            </span>
                          )}
                          <SegmentTextEditor
                            // Key on the persisted text so an external change
                            // (revert / reload) REMOUNTS the editor with the new
                            // value, re-seeding the draft without a setState-in-
                            // effect (banned by react-hooks/set-state-in-effect).
                            key={`${seg.id}:${seg.text}`}
                            initialText={seg.text}
                            onCommit={(t) => handleSegmentTextCommit(seg.id, t)}
                          />
                        </div>
                      ) : (
                        <p className="flex-1 select-text text-left">
                          {seg.speaker && (
                            <span className="mr-1.5 font-semibold">
                              {seg.speaker}:
                            </span>
                          )}
                          <span data-seg-idx={i} className="text-foreground/80">
                            {codingEnabled && highlights.length > 0
                              ? renderHighlightedText(
                                  seg.text,
                                  highlights,
                                  annById,
                                  focusAnnotation,
                                  commentedAnnIds,
                                  openCommentAnnId,
                                )
                              : seg.text}
                          </span>
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * A per-segment inline text editor for the CLEANED transcript (feature #20).
 *
 * Holds its own draft text (seeded from `initialText`) so keystrokes don't churn
 * the parent's segment list, and commits on BLUR — the natural "I'm done with
 * this segment" boundary, which debounces persistence to one write per edited
 * segment rather than per keystroke. The parent's `onCommit` no-ops when the text
 * is unchanged. The caller KEYS this component on the persisted text, so an
 * external change (a reverted edit, a version reload) REMOUNTS it with the new
 * `initialText` — re-seeding the draft without a setState-in-effect. Auto-grows
 * to its content height.
 */
function SegmentTextEditor({
  initialText,
  onCommit,
}: {
  initialText: string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initialText);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-size to content so long cleaned segments aren't clipped.
  const autoSize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);
  useEffect(() => {
    autoSize();
  }, [draft, autoSize]);

  return (
    <textarea
      ref={taRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      aria-label="Edit cleaned transcript segment"
      rows={1}
      className="w-full resize-none rounded border border-foreground/20 bg-transparent px-1.5 py-1 text-sm text-foreground/90 focus:border-emerald-500 focus:outline-none"
    />
  );
}

/**
 * Render a segment's text with its annotation char-ranges marked. Splits the
 * text at every highlight boundary (`splitIntoPieces`) and wraps each covered
 * piece in a `<mark>`-style span — emerald for code annotations, amber for
 * quotes. Overlapping ranges layer: a piece under both a code and a quote gets
 * the quote tint (quotes are the rarer, paper-bound signal).
 *
 * Clicking a marked piece OPENS its (first) annotation's comment thread and
 * focuses its rail row (the Google-Docs "click the highlight to comment" feel).
 *
 * Comment indicator: a piece whose annotation has a comment thread is given a
 * dotted sky UNDERLINE (a box-shadow, not extra text), and the currently-open
 * thread's mark gets a sky ring so it reads as "selected". Crucially the
 * indicator adds NO characters to the segment's rendered text — the selection
 * anchoring (`charOffsetWithin`) measures rendered-text length, so injecting a
 * glyph (e.g. a 💬) inside the mark would shift char offsets for selections made
 * later in the same segment and corrupt new anchors. Styling-only avoids that.
 *
 * Returned as a plain string when there are no highlights would be simpler, but
 * the caller only invokes this when `highlights.length > 0`.
 */
function renderHighlightedText(
  text: string,
  highlights: Highlight[],
  annById: Map<string, MyAnnotationView>,
  onFocus: (ann: MyAnnotationView) => void,
  commentedAnnIds: Set<string>,
  openCommentAnnId: string | null,
): React.ReactNode {
  const pieces = splitIntoPieces(text, highlights);
  return pieces.map((piece, idx) => {
    if (piece.highlightIds.length === 0) {
      return <span key={idx}>{piece.text}</span>;
    }
    const hasQuote = piece.kinds.includes('quote');
    const firstId = piece.highlightIds[0];
    const ann = annById.get(firstId);
    // Does any annotation covering this piece carry a comment thread / is open?
    const hasComment = piece.highlightIds.some((hid) => commentedAnnIds.has(hid));
    const isOpen =
      openCommentAnnId !== null && piece.highlightIds.includes(openCommentAnnId);
    const title = hasComment
      ? 'Has comments — click to open the thread'
      : hasQuote
        ? 'Flagged quote — click to comment'
        : 'Coded — click to comment';
    return (
      <mark
        key={idx}
        onClick={(e) => {
          e.stopPropagation();
          if (ann) onFocus(ann);
        }}
        title={title}
        // `decoration-dotted` sky underline = "has comments" (text-only, so it
        // never shifts char offsets); a sky ring = the currently-open thread.
        className={`cursor-pointer rounded-sm px-px ${
          hasQuote
            ? 'bg-amber-300/50 text-foreground dark:bg-amber-400/30'
            : 'bg-emerald-300/50 text-foreground dark:bg-emerald-400/30'
        } ${hasComment ? 'underline decoration-sky-500 decoration-dotted decoration-2 underline-offset-2' : ''} ${
          isOpen ? 'ring-2 ring-sky-500' : ''
        }`}
      >
        {piece.text}
      </mark>
    );
  });
}

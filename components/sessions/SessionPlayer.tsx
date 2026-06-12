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
import { type SessionEpisodeView } from '@/app/actions/episodes';
import type { ObservationView } from '@/app/actions/observations';
import type { FacetWithValues } from '@/app/actions/codebook';
import SessionCodeCreator from './SessionCodeCreator';
import {
  buildTextAnchor,
  splitIntoPieces,
  type Highlight,
  type TextAnchor,
} from '@/lib/transcript/selection';
import { groupIntoTurns } from '@/lib/transcript/turns';
import { useRealtimeAnnotations } from './useRealtimeAnnotations';

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
 * clicks and episode marks). The same flags ALSO render next to the transcript,
 * grouped under the speaker turn whose time range contains each offset
 * (`flagsByTurnIndex`), so a flag's timestamp connects to the words it was
 * logged against. Pre-record offsets clamp to 0 (mirroring the auto-episode
 * clamp); when the recording was never anchored (`recordingStartedAt` null) no
 * anchor is derivable, so the flag affordances render NOTHING (silent — no
 * alarming copy). Read-only here — flags are logged live on `/sessions/live`.
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
  sessionEpisodes = [],
  observations = [],
  recordingStartedAt = null,
  codebookId,
  facets,
  collection,
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
  /** This session's episode marks — AUTO-DERIVED from study_events (read-only
   *  seek list; the manual mark control was removed in Task 2). */
  sessionEpisodes?: SessionEpisodeView[];
  /**
   * The live co-observation flags logged for this session's participant (Task 5).
   * Each renders as a clickable marker on the time rail at
   * `createdAt − recordingStartedAt`, and in the Flags rail. Read-only here —
   * observations are created live on `/sessions/live`.
   */
  observations?: ObservationView[];
  /**
   * The EFFECTIVE recording anchor (ISO) — the t=0 that turns an observation's
   * absolute `createdAt` into a video offset. The page resolves it as the manual
   * recording mark, FALLING BACK to the participant's task start (earliest task
   * `module_start`), so it is almost always set (Task 5). `null` only when even
   * the task start can't be derived — the flag markers then render nothing
   * (silent), never a blocking "anchor not set" message.
   */
  recordingStartedAt?: string | null;
  /** The resolved codebook id new codes are authored into (SessionCodeCreator). */
  codebookId: string;
  /** The codebook's facets (each with its enum values) for the new-code panel. */
  facets: FacetWithValues[];
  /**
   * This session's `cb_sessions.collection` — the auto-assigned authoring study
   * threaded to `SessionCodeCreator` as the per-code `studyLabel`. Null outside a
   * session/collection context.
   */
  collection: string | null;
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
  // One ref per ORIGINAL cue index (NOT per turn): the active-scroll effect reads
  // `rowRefs.current[activeIdx]` to bring the active CUE into view, and the
  // active cue lives inside its turn block as its own `data-seg-idx` span. Typed
  // `HTMLElement` because a cue's element is a `<span>`, not a `<div>` row.
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
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
  // Whether the over-video comment COMPOSER (new-comment mode) is open. Opened
  // ONLY by Cmd+Opt+M on a brushed-but-uncommitted selection (plain selection is
  // just a yellow highlight, no popup). Distinct from `openCommentAnnId`, which
  // drives the EXISTING-thread view of the same callout; if a thread is open it
  // takes precedence (a fresh selection has no annotation yet).
  const [composerOpen, setComposerOpen] = useState(false);
  // Ref to the composer textarea so Cmd+Opt+M can focus it on open (next tick).
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
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
        setComposerOpen(false);
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
    setComposerOpen(false);
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
      setComposerOpen(false);
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
    // The new-comment composer is anchored to the pending selection; clearing the
    // brush closes it (an open existing-thread is independent — left untouched).
    setComposerOpen(false);
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

  // --- Comment-callout keyboard control -----------------------------------
  //
  // Cmd+Opt+M opens the over-video comment composer on a brushed selection;
  // Escape closes the callout (composer + any open thread) and clears the brush.
  // Plain text selection (`mouseup`) deliberately opens NOTHING — selecting is
  // just a (yellow) highlight; only this shortcut promotes it to a comment.
  //
  // We match on `e.code === 'KeyM'` (the physical key), NOT `e.key`: on macOS,
  // Cmd+Opt+M emits a dead/composed `key` (often 'µ' or 'Dead'), so keying on
  // `e.key === 'm'` would silently miss the shortcut. `e.code` is layout- and
  // dead-key-independent.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.altKey && e.code === 'KeyM') {
        e.preventDefault();
        // Only promote an existing brushed selection (when coding is enabled).
        if (pending && codingEnabled) {
          setOpenCommentAnnId(null); // fresh selection → new-comment mode
          setComposerOpen(true);
          // Focus the textarea after it mounts.
          setTimeout(() => composerTextareaRef.current?.focus(), 0);
        }
      } else if (e.code === 'Escape') {
        setComposerOpen(false);
        setOpenCommentAnnId(null);
        clearSelection();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pending, codingEnabled, clearSelection]);

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
      // The fresh-selection composer is done; the callout now shows the new
      // thread (opened below) instead of the new-comment composer.
      setComposerOpen(false);
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

  // The pending (brushed-but-uncommitted) text selection renders as a PERSISTENT
  // yellow highlight — Hudson's "selecting is just a highlight" model. We model it
  // as a synthetic highlight on the active segment with a sentinel annotation id
  // and `kind:'pending'`, woven into the per-segment highlight map so a cue that
  // is ONLY brushed (no real annotation) still hits the `highlights.length > 0`
  // render branch and paints yellow. It is NOT a real annotation — it carries no
  // `annById` entry and is never clickable; it clears exactly when `textSel` does.
  const PENDING_ANN_ID = '__pending__';
  const highlightsBySegmentWithPending = useMemo(() => {
    if (!textSel) return highlightsBySegment;
    const seg = segments[textSel.segIdx];
    if (!seg) return highlightsBySegment;
    const m = new Map(highlightsBySegment);
    const list = [...(m.get(seg.id) ?? [])];
    list.push({
      annotationId: PENDING_ANN_ID,
      charStart: textSel.anchor.charStart,
      charEnd: textSel.anchor.charEnd,
      kind: 'pending',
    });
    m.set(seg.id, list);
    return m;
  }, [textSel, segments, highlightsBySegment]);

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
  // recordingStartedAt null → no anchor derivable at all (not even task start):
  // this is empty and the flag UI renders nothing (silent — no hint). Normally the
  // page supplies the task-start fallback, so an anchor is present.
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

  // --- Speaker-turn grouping (Change 1a) ----------------------------------
  //
  // The transcript renders ONE block per speaker TURN (a maximal run of
  // consecutive same-speaker cues) instead of one row per SRT cue, so a
  // monologue stays in one block and the only break is a speaker change
  // (the "arbitrary per-cue breaks" Hudson is removing). `groupIntoTurns`
  // returns each turn's ORIGINAL segment indices (not copies) — CRUCIAL,
  // because every cue must keep its own `data-seg-idx={originalIndex}` so
  // `resolveSelection`/`charOffsetWithin`/`highlightsBySegment` (all keyed on a
  // single cue's element + `seg.id`) keep working unchanged: a brush still
  // resolves within ONE cue's text element, and sub-segment annotation
  // anchoring is untouched. Only the visual grouping changes here.
  const turns = useMemo(() => groupIntoTurns(segments), [segments]);

  // Flags placed NEXT TO THE TRANSCRIPT (Change 5): group each live-flag marker
  // under the turn it falls inside, so a flag's `[mm:ss]` sits with the words it
  // was logged against ("flags must have timestamps that connect to the script").
  // A flag belongs to turn t iff `offsetMs ∈ [t.startMs, t.endMs)`. Flags before
  // the FIRST turn's start attach to the first turn; flags at/after the LAST
  // turn's end attach to the last turn — so none are dropped (turn time ranges
  // may not tile the whole video, and pre-record flags clamp to 0). Empty when
  // there's no anchor (`flagMarkers` is already []), so the gutter renders nothing.
  const flagsByTurnIndex = useMemo(() => {
    const m = new Map<number, { obs: ObservationView; offsetMs: number }[]>();
    if (turns.length === 0) return m;
    const lastTurnIdx = turns.length - 1;
    for (const marker of flagMarkers) {
      // First turn whose [startMs, endMs) contains the offset; else clamp to the
      // first/last turn by comparing against the boundary turns' ranges.
      let turnIdx = turns.findIndex(
        (t) => marker.offsetMs >= t.startMs && marker.offsetMs < t.endMs,
      );
      if (turnIdx === -1) {
        turnIdx = marker.offsetMs < turns[0].startMs ? 0 : lastTurnIdx;
      }
      const list = m.get(turnIdx) ?? [];
      list.push(marker);
      m.set(turnIdx, list);
    }
    return m;
  }, [turns, flagMarkers]);

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

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left (1/2): video + (when enabled) coding toolbar + own-coding rail */}
        <div className="space-y-4 lg:col-span-1">
          {/* Relative wrapper: the positioning anchor for the comment callout
              that overlays the video. The callout floats over the video's
              top-right; it is the SINGLE home for both leaving a NEW comment on a
              fresh selection (composer) and viewing an EXISTING excerpt's thread
              (clicking a yellow span) — there is no comment box in the left
              column anymore. */}
          <div className="relative">
            <video
              ref={videoRef}
              controls
              preload="metadata"
              src={`/api/media/${id}/video`}
              onTimeUpdate={handleTimeUpdate}
              className="w-full bg-black"
            />

            {/* Over-video comment callout. Existing-thread view (openCommentAnn)
                takes precedence over the new-comment composer: clicking a yellow
                span opens its thread here, while Cmd+Opt+M on a fresh selection
                opens the composer. Both can't sensibly coexist; if a thread is
                open we show it. */}
            {codingEnabled && (openCommentAnn || composerOpen) && (
              <div className="absolute right-3 top-3 z-20 w-[22rem] max-h-[85%] overflow-auto rounded-lg border border-foreground/20 bg-background/95 shadow-xl backdrop-blur p-3">
                {openCommentAnn ? (
                  /* EXISTING-THREAD mode: the excerpt + codes header, the thread
                     list, and the add-comment input — relocated here from the old
                     left-column section. */
                  <>
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

                    {/* The anchored excerpt + its codes (what you're commenting
                        on — the Docs comment-card header). */}
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
                  </>
                ) : (
                  /* NEW-COMMENT mode: a fresh brushed selection (no annotation
                     yet). Show the excerpt, a draft textarea, and Comment/Cancel.
                     Comment → handleCommentOnSelection (creates a quote anchor +
                     first comment, then opens its thread here). */
                  <>
                    <div className="mb-2 flex items-start gap-2">
                      <h2 className="text-sm font-semibold">
                        Comment
                        <span className="ml-1 font-normal text-foreground/40">
                          on selection
                        </span>
                      </h2>
                      <button
                        type="button"
                        onClick={() => {
                          setComposerOpen(false);
                          setCommentError(null);
                          setSelectionCommentDraft('');
                          clearSelection();
                        }}
                        aria-label="Close comment composer"
                        className="ml-auto text-foreground/40 hover:text-foreground"
                      >
                        {'✕'}
                      </button>
                    </div>

                    {pending && (
                      <div className="mb-2 rounded border border-foreground/10 bg-background/40 px-2 py-1.5 text-sm italic text-foreground/80">
                        “{pending.anchor.quoteText.length > 120
                          ? pending.anchor.quoteText.slice(0, 120) + '…'
                          : pending.anchor.quoteText}”
                      </div>
                    )}

                    {commentError && (
                      <p className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300">
                        {commentError}
                      </p>
                    )}

                    <textarea
                      ref={composerTextareaRef}
                      value={selectionCommentDraft}
                      onChange={(e) => setSelectionCommentDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          if (canCommentOnSelection) void handleCommentOnSelection();
                        }
                      }}
                      placeholder="Comment on this selection… (⌘/Ctrl+Enter to send)"
                      rows={3}
                      className="mb-2 w-full resize-none rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
                      aria-label="Comment on selection"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setComposerOpen(false);
                          setSelectionCommentDraft('');
                          clearSelection();
                        }}
                        className="rounded border border-foreground/30 px-3 py-1 text-sm text-foreground/70 hover:text-foreground"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleCommentOnSelection}
                        disabled={!canCommentOnSelection}
                        className="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-40"
                      >
                        {commentBusy ? 'Commenting…' : 'Comment'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Live-flag marker rail (Task 5): the participant's live observations
              placed along an absolute time rail at `createdAt − recording start`.
              Each marker is a button → seekTo(offset); its color is the flag's
              swatch; its title shows the label + note. Read-only (flags are
              created live on /sessions/live). When the recording was never
              anchored we can't place anything, so the flag affordances render
              nothing (silent — no alarming copy). */}
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
              {/* No "anchor not set" copy (Change 5): when no anchor is
                  derivable (`anchorMs === null`) we render NOTHING for flags —
                  the overview rail + Flags list below are already guarded on
                  `anchorMs !== null`, so the section is silent rather than
                  showing alarming copy. */}
              {anchorMs !== null && (
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
              {/* Events (auto-derived, Task 2): the navigable timeline of episode
                  boundaries derived from the participant's task clock on page load
                  (see `materializeAutoEpisodes`). READ-ONLY here — each row is a
                  seek button only; there is no manual mark/delete. "Manage presets"
                  still links to the codebook's preset-event editor. */}
              <section className="rounded border border-foreground/15 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">
                    Events
                    <span className="ml-1 font-normal text-foreground/40">
                      · auto-derived
                    </span>
                  </h2>
                  <Link
                    href="/episodes"
                    className="ml-auto text-xs text-foreground/50 underline hover:text-foreground"
                    title="Manage the codebook's preset events"
                  >
                    Manage presets
                  </Link>
                </div>

                {sessionEpisodes.length === 0 ? (
                  <p className="text-sm text-foreground/50">No events derived yet.</p>
                ) : (
                  <ul className="divide-y divide-foreground/10">
                    {sessionEpisodes.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center gap-2 py-1.5 text-sm"
                      >
                        <button
                          type="button"
                          onClick={() => seekTo(m.tStartMs)}
                          className="flex-1 text-left hover:underline"
                          title="Seek to this event"
                        >
                          <span className="font-semibold">{m.episodeName}</span>{' '}
                          <span className="font-mono text-xs text-foreground/50">
                            [{formatTime(m.tStartMs)}]
                          </span>
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

                {/* Commenting on a selection lives in the over-video callout now,
                    not here: brush text (it stays yellow-highlighted) and press
                    ⌘+⌥+M to open the comment composer over the video. */}
                {pending && (
                  <p className="mt-2 border-t border-foreground/10 pt-2 text-xs text-foreground/50">
                    To comment, press{' '}
                    <kbd className="rounded border border-foreground/20 bg-foreground/5 px-1 font-mono">
                      ⌘
                    </kbd>
                    +
                    <kbd className="rounded border border-foreground/20 bg-foreground/5 px-1 font-mono">
                      ⌥
                    </kbd>
                    +
                    <kbd className="rounded border border-foreground/20 bg-foreground/5 px-1 font-mono">
                      M
                    </kbd>{' '}
                    — the comment box opens over the video.
                  </p>
                )}
              </section>

              {/* (The per-excerpt comment thread used to live here; it now opens
                  in the over-video callout — see the `relative` video wrapper.) */}

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

              {/* New-code panel (Task 5): authoring new codes lives BELOW the
                  video and the codes rail (NOT below the transcript). Creating a
                  code refreshes the server tree so the code picker above picks it
                  up. `collection` is threaded through as the study attribution. */}
              <SessionCodeCreator
                codebookId={codebookId}
                facets={facets}
                studyLabel={collection}
                onCreated={() => router.refresh()}
              />
            </>
          )}
        </div>

        {/* Right (1/2): version tabs + scrollable, click-to-seek transcript */}
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
                /* ONE block per speaker TURN (Change 1a). A turn is a maximal run
                   of consecutive same-speaker cues, so a monologue is one block
                   and the only divider is a speaker change. The speaker label and
                   a single `[mm:ss]` seek button (turn.startMs) render ONCE per
                   block; the cues render INLINE in one selectable `<p>`. Each cue
                   keeps its OWN `data-seg-idx={originalIndex}` span and its own
                   `rowRefs` entry — so `resolveSelection`/`highlightsBySegment`
                   (sub-segment anchoring) and the active-cue scroll are unchanged;
                   only the visual grouping moved from per-cue to per-turn. */
                turns.map((turn, turnIdx) => {
                  const firstSeg = segments[turn.segIndices[0]];
                  const speaker = firstSeg?.speaker ?? null;
                  // The turn is "annotated" (emerald accent) if ANY of its cues
                  // carries a highlight; the active-cue tint is applied per cue.
                  const turnAnnotated =
                    codingEnabled &&
                    turn.segIndices.some(
                      (si) => (highlightsBySegment.get(segments[si].id)?.length ?? 0) > 0,
                    );
                  // Flags whose offset falls inside this turn (Change 5) — render
                  // as a chip row ABOVE the turn so the flag's `[mm:ss]` sits with
                  // the words it was logged against.
                  const turnFlags = flagsByTurnIndex.get(turnIdx) ?? [];
                  return (
                    <div
                      key={firstSeg?.id ?? turnIdx}
                      className={`px-2 py-2 text-sm ${
                        turnAnnotated
                          ? 'border-l-2 border-l-emerald-500'
                          : 'border-l-2 border-l-transparent'
                      }`}
                    >
                      {/* In-transcript flag chips (Change 5): each chip is a seek
                          button → flag swatch + label + note + [mm:ss]. A thin
                          left-accent + pill keeps them visually distinct from the
                          transcript text. Only present when an anchor exists
                          (`flagMarkers`/`flagsByTurnIndex` are empty otherwise). */}
                      {turnFlags.length > 0 && (
                        <div className="mb-1.5 flex flex-col gap-1">
                          {turnFlags.map(({ obs, offsetMs }) => {
                            const label = observationLabel(obs);
                            return (
                              <button
                                key={obs.id}
                                type="button"
                                onClick={() => seekTo(offsetMs)}
                                title={`[${formatTime(offsetMs)}] ${label}${
                                  obs.body ? ` — ${obs.body}` : ''
                                }`}
                                className="flex items-start gap-1.5 rounded border-l-2 bg-foreground/[0.04] py-0.5 pl-1.5 pr-2 text-left text-xs hover:bg-foreground/[0.08]"
                                style={{ borderLeftColor: observationColor(obs) }}
                              >
                                <span
                                  aria-hidden
                                  style={{ backgroundColor: observationColor(obs) }}
                                  className="mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-foreground/20"
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
                                <span className="shrink-0 font-mono text-foreground/50">
                                  [{formatTime(offsetMs)}]
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      <div className="flex items-start gap-1">
                        {/* ONE seek affordance per turn (turn.startMs). */}
                        <button
                          type="button"
                          onClick={() => seekTo(turn.startMs)}
                          title="Seek to here"
                          className="mt-px shrink-0 font-mono text-xs text-foreground/40 hover:text-foreground hover:underline"
                        >
                          [{formatTime(turn.startMs)}]
                        </button>

                        {/* CLEANING mode (cleaned tab + Edit on): speaker label
                            once, then EACH cue in the turn as its own
                            `SegmentTextEditor`, stacked — per-cue editability
                            preserved (no cue is lost) under one turn header. */}
                        {isCleanedActive && editing ? (
                          <div className="flex-1">
                            {speaker && (
                              <span className="mb-0.5 block text-xs font-semibold text-foreground/60">
                                {speaker}:
                              </span>
                            )}
                            <div className="space-y-1">
                              {turn.segIndices.map((si) => {
                                const seg = segments[si];
                                return (
                                  <SegmentTextEditor
                                    // Key on the persisted text so an external
                                    // change (revert / reload) REMOUNTS the editor
                                    // with the new value, re-seeding the draft
                                    // without a setState-in-effect (banned by
                                    // react-hooks/set-state-in-effect).
                                    key={`${seg.id}:${seg.text}`}
                                    initialText={seg.text}
                                    onCommit={(t) => handleSegmentTextCommit(seg.id, t)}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          /* READ/CODE mode: the turn's cues INLINE in one
                             selectable `<p>`, separated by a single space. Each
                             cue keeps its OWN `data-seg-idx={originalIndex}` span
                             (so a brush still resolves within ONE cue and
                             sub-segment anchoring is intact) and its own `rowRefs`
                             entry (so the active-cue scroll still finds it). The
                             active cue is tinted; the turn block stays calm. */
                          <p className="flex-1 select-text text-left">
                            {speaker && (
                              <span className="mr-1.5 font-semibold">
                                {speaker}:
                              </span>
                            )}
                            {turn.segIndices.map((si, posInTurn) => {
                              const seg = segments[si];
                              // Source from the map that INCLUDES the pending
                              // selection, so a cue that is only brushed (no real
                              // annotation) still hits the highlight render branch
                              // and paints the transient yellow mark.
                              const highlights =
                                highlightsBySegmentWithPending.get(seg.id) ?? [];
                              const active = si === activeIdx;
                              return (
                                <span key={seg.id}>
                                  {/* Single space between cues within the turn. */}
                                  {posInTurn > 0 ? ' ' : null}
                                  <span
                                    data-seg-idx={si}
                                    ref={(el) => {
                                      rowRefs.current[si] = el;
                                    }}
                                    className={`text-foreground/80 ${
                                      active ? 'rounded-sm bg-foreground/10' : ''
                                    }`}
                                  >
                                    {codingEnabled && highlights.length > 0
                                      ? renderHighlightedText(
                                          seg.text,
                                          highlights,
                                          annById,
                                          focusAnnotation,
                                          commentedAnnIds,
                                          openCommentAnnId,
                                          PENDING_ANN_ID,
                                        )
                                      : seg.text}
                                  </span>
                                </span>
                              );
                            })}
                          </p>
                        )}
                      </div>
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
 * piece in a `<mark>`-style span.
 *
 * Colors (Hudson's "comments are highlighted too" model — quotes/comments read
 * as one consistent YELLOW):
 *   • code-only span → emerald
 *   • quote span OR any span whose annotation carries comments → yellow
 *   • the PENDING (brushed-but-uncommitted) selection → a transient yellow brush
 *
 * The pending highlight: the caller weaves a synthetic highlight with id
 * `pendingAnnId` and `kind:'pending'` into the segment's highlight set. A piece
 * may carry BOTH a real annotation id and the pending id (the brush overlapping
 * an existing mark): if it includes ANY non-pending id we keep the normal
 * clickable annotation behavior; a PURE-pending piece (only the sentinel id) is
 * the non-clickable yellow brush — no `annById` lookup, no `onFocus`, no thread.
 *
 * Clicking a (real) marked piece OPENS its (first real) annotation's comment
 * thread in the over-video callout and focuses its rail row.
 *
 * Comment indicator: a piece whose annotation has a comment thread is given a
 * dotted sky UNDERLINE (a box-shadow, not extra text), and the currently-open
 * thread's mark gets a sky ring so it reads as "selected". Crucially the
 * indicator (and the pending brush) add NO characters to the segment's rendered
 * text — selection anchoring (`charOffsetWithin`) measures rendered-text length,
 * so injecting a glyph would shift char offsets for later selections and corrupt
 * new anchors. Styling-only avoids that.
 *
 * The caller only invokes this when `highlights.length > 0`.
 */
function renderHighlightedText(
  text: string,
  highlights: Highlight[],
  annById: Map<string, MyAnnotationView>,
  onFocus: (ann: MyAnnotationView) => void,
  commentedAnnIds: Set<string>,
  openCommentAnnId: string | null,
  pendingAnnId: string,
): React.ReactNode {
  const pieces = splitIntoPieces(text, highlights);
  return pieces.map((piece, idx) => {
    if (piece.highlightIds.length === 0) {
      return <span key={idx}>{piece.text}</span>;
    }
    // Real annotation ids covering this piece (excluding the pending sentinel).
    const realIds = piece.highlightIds.filter((hid) => hid !== pendingAnnId);

    // PURE-pending piece: the transient yellow brush. Not an annotation — never
    // clickable, no thread, no rail focus. Clears when `textSel` clears.
    if (realIds.length === 0) {
      return (
        <mark
          key={idx}
          className="rounded-sm bg-yellow-300/60 px-px text-foreground dark:bg-yellow-400/30"
        >
          {piece.text}
        </mark>
      );
    }

    const hasQuote = piece.kinds.includes('quote');
    const firstId = realIds[0];
    const ann = annById.get(firstId);
    // Does any REAL annotation covering this piece carry a comment thread / open?
    const hasComment = realIds.some((hid) => commentedAnnIds.has(hid));
    const isOpen =
      openCommentAnnId !== null && realIds.includes(openCommentAnnId);
    // Yellow when it's a quote OR carries comments ("comments are highlighted
    // too"); emerald only for a code-only span with no comments.
    const isYellow = hasQuote || hasComment;
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
          isYellow
            ? 'bg-yellow-300/55 text-foreground dark:bg-yellow-400/30'
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

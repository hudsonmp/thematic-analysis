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
  setAnnotationKind,
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
import type { ChatMessage } from '@/app/actions/chat';
import { alignChat, activeChatIndex } from '@/lib/chat/align';
import type { FacetWithValues } from '@/app/actions/codebook';
import type { Tables } from '@/lib/types/cb-db';
import SessionCodeCreator from './SessionCodeCreator';
import CodingPanel from './CodingPanel';
import ChatReplayPane from './ChatReplayPane';
import {
  buildMultiAnchor,
  splitIntoPieces,
  type Highlight,
} from '@/lib/transcript/selection';
import { groupIntoTurns } from '@/lib/transcript/turns';
import { findActiveIndex, nearestCueIndex } from '@/lib/transcript/active';
import { findPhraseMatches } from '@/lib/transcript/search';
import { cardsByTurn, type RailCard } from '@/lib/transcript/rail';
import { useRealtimeAnnotations } from './useRealtimeAnnotations';

/** Minimal code shape the picker needs (flattened from the codebook tree). */
type CodeOption = { id: string; mnemonic: string; name: string };

/** A resolved transcript selection that may span MULTIPLE cues. `startSegIdx`/
 *  `startChar` is where it begins, `endSegIdx`/`endChar` where it ends (start ≤
 *  end in transcript order); the anchor fields are the built quote/context. */
type TextSelection = {
  startSegIdx: number;
  startChar: number;
  endSegIdx: number;
  endChar: number;
  quoteText: string;
  prefix: string;
  suffix: string;
};

/** The two player surfaces: REVIEW (read + comment, video 1/3 + transcript 2/3 with
 *  a Google-Docs comment margin) and CODING (apply codes, video 1/3 + coding panel
 *  1/3 + transcript 1/3). Toggled in the header. */
type Mode = 'review' | 'coding';

/** Format a millisecond offset as `mm:ss` (minutes uncapped past 60). */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The display label for an observation marker/row. A flag tap uses its flag's
 * label; a flag whose type was deleted shows the action's '(deleted flag)'
 * sentinel; a bare note (no flag) reads "Note". Kept separate from the body
 * (the free-text comment), which renders alongside it.
 */
function observationLabel(o: { flagLabel: string | null; isQuote?: boolean }): string {
  if (o.flagLabel) return o.flagLabel;
  if (o.isQuote) return 'Quote';
  return 'Note';
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
 * A MEANINGFUL observation carries signal: a flag, a free-text note, or a quote
 * bookmark. Everything else — most importantly the empty "Note" rows that are
 * stale manual EVENTS mis-translated into bare observations (no flag, no body,
 * not a quote) — is noise and is filtered OUT of the flags surfaces (Change R3).
 * This is a non-destructive UI filter; the `cb_observations` rows are untouched.
 */
function isMeaningfulObservation(o: {
  flagLabel: string | null;
  body: string | null;
  isQuote: boolean;
}): boolean {
  return !!o.flagLabel || !!(o.body && o.body.trim()) || o.isQuote;
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

// Cue resolution lives in lib/transcript/active.ts as pure, unit-tested helpers:
//   • findActiveIndex  — tightest CONTAINING cue (or -1), for the follow-along
//     highlight; shortest-span-wins so it advances phrase-by-phrase through a
//     multi-track transcript instead of sticking on a long track-level block.
//   • nearestCueIndex  — containing-or-nearest, for live flags (every flag attaches
//     to some text even when its time lands in an inter-cue gap).
// `CloudSegment` is assignable to their `TimedCue` shape.

/**
 * Resolve the current `window.getSelection()` to a (possibly multi-segment) raw
 * char range over the transcript.
 *
 * Each cue's text is rendered into ONE element tagged `data-seg-idx={i}`. We walk
 * up from BOTH selection boundaries to their cue elements (which may be DIFFERENT
 * cues, even in different turns — multi-CUE selection). A DOM Range is always in
 * document order (`startContainer` ≤ `endContainer`), so the start cue index is ≤
 * the end cue index and no swap is needed. Char offsets within each cue are
 * measured with `charOffsetWithin` (rendered-text length — robust to split text
 * nodes), so they line up with the anchor model's char ranges.
 *
 * Returns `{ startSegIdx, startChar, endSegIdx, endChar }` (raw — the caller
 * builds the `MultiAnchor` from the covered cue texts), or `null` when either
 * boundary isn't inside a cue's text element (e.g. a drag that begins on a speaker
 * label) or the selection is collapsed.
 */
function resolveSelection(
  root: HTMLElement | null,
): { startSegIdx: number; startChar: number; endSegIdx: number; endChar: number } | null {
  if (!root) return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  const startEl = segElementFor(range.startContainer, root);
  const endEl = segElementFor(range.endContainer, root);
  if (!startEl || !endEl) return null;

  const startSegIdx = Number(startEl.dataset.segIdx);
  const endSegIdx = Number(endEl.dataset.segIdx);
  if (!Number.isInteger(startSegIdx) || !Number.isInteger(endSegIdx)) return null;

  const startChar = charOffsetWithin(startEl, range.startContainer, range.startOffset);
  const endChar = charOffsetWithin(endEl, range.endContainer, range.endOffset);
  return { startSegIdx, startChar, endSegIdx, endChar };
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
 * Expand a (possibly multi-cue) char range into ONE {@link Highlight} per covered
 * cue, all sharing `annotationId` so they read as a single annotation (clicking
 * any piece opens the same card; `splitIntoPieces` layers them per cue):
 *   • the START cue is highlighted from `startChar` to its end,
 *   • every MIDDLE cue is highlighted whole,
 *   • the END cue is highlighted from 0 to `endChar`.
 * A single-cue range (`startIdx === endIdx`) yields one highlight `[startChar,
 * endChar)`, identical to the pre-multi-segment behavior. Returns `[segId,
 * Highlight]` pairs so the caller can bucket them by segment id.
 */
function expandRangeHighlights(
  annotationId: string,
  kind: string,
  startIdx: number,
  startChar: number,
  endIdx: number,
  endChar: number,
  segments: CloudSegment[],
  color?: string,
): Array<[string, Highlight]> {
  const out: Array<[string, Highlight]> = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const cs = i === startIdx ? startChar : 0;
    const ce = i === endIdx ? endChar : seg.text.length;
    out.push([seg.id, { annotationId, charStart: cs, charEnd: ce, kind, color }]);
  }
  return out;
}

/**
 * The participant-session player. A header MODE toggle switches between:
 *
 *  • REVIEW (default): video at 1/3 width on the left; the transcript at 2/3 on
 *    the right with a Google-Docs COMMENT MARGIN in the reserved whitespace to its
 *    right. Select transcript text → it stays YELLOW; ⌘⌥M opens a comment card in
 *    the margin aligned to the selection (cursor focused); ⌘⇧J (in a card) marks
 *    the excerpt as an important quote. Clicking a yellow span re-opens its card.
 *  • CODING: video 1/3 · a CodingPanel (fuzzy code search) 1/3 · transcript 1/3.
 *    Pick a code by typing an approximate description; Enter applies it at the
 *    current video time (anchored to a brushed selection if any, else the cue
 *    playing now).
 *
 * Sync (video → transcript): when SYNC is on (default), the video's `timeupdate`
 * recomputes the active segment and scrolls it into view, so scrubbing drags the
 * transcript along. Seek (transcript → video): clicking a turn's TIMESTAMP sets
 * `currentTime` and plays.
 *
 * Transcript model: ONE block per speaker TURN (a maximal run of same-speaker
 * cues — `groupIntoTurns`), rendered as flowing text (no cell borders) where each
 * cue keeps its own `data-seg-idx` span so sub-segment selection anchoring and
 * per-cue highlights are unchanged.
 *
 * Live-flag review (Task 5 + R4): the participant's MEANINGFUL live observations
 * (`isMeaningfulObservation`) are placed at `createdAt − recordingStartedAt` and
 * (a) tint the transcript cue playing at that moment with the flag's swatch color,
 * and (b) list, time-ordered, in a collapsed "Flags on timeline" rail. A
 * current-event box above the flags shows the auto-derived episode now playing.
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
  chatMessages = [],
  recordingStartedAt = null,
  codebookId,
  facets,
  labels = [],
  collection,
  compareHref = null,
}: {
  id: string;
  pidLabel: string;
  /** The ORIGINAL version's segments (the default tab the page renders). */
  segments: CloudSegment[];
  durationMs: number;
  /** Render the coding affordances (selection, comments, coding mode). */
  codingEnabled?: boolean;
  /** The original transcript version id annotations anchor to (version_id). */
  versionId?: string | null;
  /** All of the session's transcript versions (the Original/Cleaned tab set). */
  versions?: SessionVersion[];
  codes?: CodeOption[];
  /** The signed-in coder's OWN annotations for the ORIGINAL version (initial). */
  myAnnotations?: MyAnnotationView[];
  /** Per-excerpt comment threads, grouped by annotation id (#17/#18). */
  comments?: Record<string, AnnotationCommentView[]>;
  /** The signed-in coder's auth uid — used to scope realtime sync to own rows. */
  myUid?: string | null;
  /** This session's episode marks — AUTO-DERIVED from study_events (read-only). */
  sessionEpisodes?: SessionEpisodeView[];
  /** The live co-observation flags logged for this session's participant (Task 5). */
  observations?: ObservationView[];
  /** The participant's LLM-assistant chat (chat-replay) — aligned client-side to
   *  the SAME `anchorMs` the flags use, so chat/flags/transcript share one clock. */
  chatMessages?: ChatMessage[];
  /** The EFFECTIVE recording anchor (ISO) — t=0 for turning an observation's
   *  absolute `createdAt` into a video offset. Null only when even the task start
   *  can't be derived (the flag surfaces then render nothing, silently). */
  recordingStartedAt?: string | null;
  /** The resolved codebook id new codes are authored into (SessionCodeCreator). */
  codebookId: string;
  /** The codebook's facets (each with its enum values) for the new-code panel. */
  facets: FacetWithValues[];
  /** The codebook's labels (themes) for OPTIONAL tagging in the new-code panel. */
  labels?: Tables<'cb_labels'>[];
  /** This session's `cb_sessions.collection` — the per-code authoring study. */
  collection: string | null;
  /** Link to the post-hoc, read-only Compare tab. */
  compareHref?: string | null;
}) {
  const router = useRouter();

  // --- Mode (REVIEW / CODING) ---------------------------------------------
  const [mode, setMode] = useState<Mode>('review');

  // --- Transcript layers (feature #20): original (verbatim) vs cleaned --------
  const cleanedVersionFromList = versions.find((v) => v.kind === 'cleaned') ?? null;
  const [activeTab, setActiveTab] = useState<'original' | 'cleaned'>('original');
  const [versionId, setVersionId] = useState<string | null>(originalVersionId);
  const [cleanedVersionId, setCleanedVersionId] = useState<string | null>(
    cleanedVersionFromList?.id ?? null,
  );

  const [segments, setSegments] = useState<CloudSegment[]>(initialSegments);
  const [myAnnotations, setMyAnnotations] =
    useState<MyAnnotationView[]>(initialAnnotations);
  const [comments, setComments] =
    useState<Record<string, AnnotationCommentView[]>>(initialComments);

  const originalSegmentsRef = useRef<CloudSegment[]>(initialSegments);

  const [versionBusy, setVersionBusy] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const isCleanedActive = activeTab === 'cleaned';
  const isVerbatim = activeTab === 'original';

  const reloadComments = useCallback(async (annotationIds: string[]) => {
    if (annotationIds.length === 0) {
      setComments({});
      return;
    }
    const next = await listAnnotationComments(annotationIds);
    setComments(next);
  }, []);

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
    // Always refetch into client state (BOTH tabs). `versionId` is set on the
    // 'original' tab too, so `refreshActiveAnnotations` works there; a bare
    // router.refresh() re-passed the prop but never synced it into `myAnnotations`
    // state, so new annotations never rendered (issue A root cause).
    onChange: () => {
      void refreshActiveAnnotations();
    },
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // One ref per ORIGINAL cue index: the active-scroll effect and the comment
  // margin both read `rowRefs.current[i]?.offsetTop` to align to a cue.
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  const currentEventRef = useRef<HTMLLIElement | null>(null);

  const [activeIdx, setActiveIdx] = useState(-1);
  // The current playhead in ms, rounded to the second (drives the current-event
  // box + "apply code at current time"). Rounded so it re-renders ≤1×/s.
  const [currentMs, setCurrentMs] = useState(0);

  const [synced, setSynced] = useState(true);
  // Whether the time-aligned AI-chat replay pane is open (chat-replay feature).
  // Default hidden — the split shrinks the transcript, so opt-in. When on, the
  // transcript container goes h-[80vh] → h-[40vh] and ChatReplayPane fills the
  // other 40vh below it, in BOTH the review and coding branches.
  const [showChat, setShowChat] = useState(false);
  const syncedRef = useRef(true);
  useEffect(() => {
    syncedRef.current = synced;
  }, [synced]);

  // --- Text selection (Google-Docs style, sub-segment) --------------------
  const [textSel, setTextSel] = useState<TextSelection | null>(null);

  // --- Transcript phrase search -------------------------------------------
  const [searchQuery, setSearchQuery] = useState('');
  // Index into `searchMatches` of the "current" match (the one we scroll to and
  // paint brighter). Reset to 0 whenever the query changes (handled during render
  // below, not in an effect — the repo bans set-state-in-effect).
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [prevSearchQuery, setPrevSearchQuery] = useState('');
  // In CODING mode there is no comment gutter, so a clicked commented highlight
  // shows its thread in a floating popover at the click point (null = closed).
  const [commentPopoverPos, setCommentPopoverPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  // Phrase-search matches over the current (ordered) segments, in reading order.
  const searchMatches = useMemo(
    () => findPhraseMatches(segments, searchQuery),
    [segments, searchQuery],
  );
  // Reset to the first match whenever the query changes — during render, not in an
  // effect (the repo bans set-state-in-effect). `safeMatchIdx` then clamps a stale
  // index if the match set shrank; -1 means "no matches".
  if (searchQuery !== prevSearchQuery) {
    setPrevSearchQuery(searchQuery);
    setCurrentMatchIdx(0);
  }
  const safeMatchIdx =
    searchMatches.length === 0 ? -1 : Math.min(currentMatchIdx, searchMatches.length - 1);

  // --- Per-excerpt comments (margin cards) --------------------------------
  // The annotation whose comment thread is OPEN (its card shows in the margin).
  const [openCommentAnnId, setOpenCommentAnnId] = useState<string | null>(null);
  // Whether the new-comment COMPOSER card is open (⌘⌥M on a fresh selection).
  const [composerOpen, setComposerOpen] = useState(false);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [selectionCommentDraft, setSelectionCommentDraft] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentRowBusyId, setCommentRowBusyId] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);

  // --- Coding (apply a code) ----------------------------------------------
  const [applying, setApplying] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const tMs = video.currentTime * 1000;
    const idx = findActiveIndex(segments, tMs);
    setActiveIdx((prev) => (prev === idx ? prev : idx));
    // Round to the second so the current-event box re-renders at most once/s.
    const sec = Math.floor(video.currentTime) * 1000;
    setCurrentMs((prev) => (prev === sec ? prev : sec));
  }, [segments]);

  useEffect(() => {
    if (activeIdx < 0) return;
    if (!syncedRef.current) return;
    rowRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const seekTo = useCallback((targetMs: number) => {
    const video = videoRef.current;
    if (!video) return;
    const doSeek = () => {
      // Clamp into the seekable range. A flag/episode offset can land AT or just
      // PAST the end (the recording anchor is approximate), and assigning an
      // out-of-range currentTime makes the browser snap the playhead to the very
      // end — the "jumps to end of video" symptom. Pull back a hair from the exact
      // end so we land on a real frame, not the ended state.
      const dur =
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      let t = Math.max(0, targetMs / 1000);
      if (dur !== null) t = Math.min(t, Math.max(0, dur - 0.3));

      // Clicking a marker means "play from here". Assigning currentTime while the
      // element is ACTIVELY playing a streamed source makes it reload from the start
      // ("starts over"); paused, the same assignment seeks fine. So PAUSE first, set
      // the target, and resume once the seek completes. A no-op seek (target ≈ now)
      // fires no 'seeked', so just play in place.
      if (Math.abs(video.currentTime - t) < 0.05) {
        void video.play();
        return;
      }
      video.pause();
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        void video.play();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = t;
    };
    // Seeking before metadata is loaded is unreliable (currentTime can be ignored
    // or snap to 0/end), which is the other half of the intermittent "sometimes it
    // works" behavior. Defer the seek until we at least have duration/seekable
    // ranges (preload="metadata" usually means this is already true).
    if (video.readyState >= 1 /* HAVE_METADATA */) {
      doSeek();
    } else {
      const onReady = () => {
        video.removeEventListener('loadedmetadata', onReady);
        doSeek();
      };
      video.addEventListener('loadedmetadata', onReady);
    }
  }, []);

  // --- Version switching (Original / Cleaned tabs) ------------------------

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

  const handleSelectCleaned = useCallback(async () => {
    if (activeTab === 'cleaned') return;
    setActiveTab('cleaned');
    setEditing(false);
    if (cleanedVersionId) {
      await loadVersion(cleanedVersionId);
    } else {
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

  const handleSegmentTextCommit = useCallback(
    async (segmentId: string, nextText: string) => {
      const current = segments.find((s) => s.id === segmentId);
      if (!current) return;
      const trimmed = nextText;
      if (trimmed === current.text) return;
      if (trimmed.trim() === '') {
        setSegments((prev) => prev.map((s) => ({ ...s })));
        setVersionError('A cleaned segment cannot be blank.');
        return;
      }
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

  const handleTranscriptMouseUp = useCallback((e: React.MouseEvent) => {
    // The comment cards live INSIDE this container's onMouseUp. A mouseup inside a
    // card (e.g. clicking into the composer textarea to type) carries no transcript
    // text selection, so resolving it would clear `textSel` — which unanchors and
    // HIDES the composer mid-comment. Ignore those; only transcript-text mouseups
    // update the selection.
    if ((e.target as HTMLElement | null)?.closest?.('[data-comment-card]')) return;
    const r = resolveSelection(transcriptRef.current);
    if (!r || r.startSegIdx < 0 || r.endSegIdx >= segments.length || r.startSegIdx > r.endSegIdx) {
      setTextSel(null);
      return;
    }
    // Build the (possibly multi-cue) anchor from the covered cues' texts.
    const segTexts: string[] = [];
    for (let i = r.startSegIdx; i <= r.endSegIdx; i++) segTexts.push(segments[i].text);
    const anchor = buildMultiAnchor(segTexts, r.startChar, r.endChar);
    if (!anchor) {
      setTextSel(null);
      return;
    }
    setTextSel({
      startSegIdx: r.startSegIdx,
      endSegIdx: r.endSegIdx,
      startChar: anchor.startChar,
      endChar: anchor.endChar,
      quoteText: anchor.quoteText,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    });
  }, [segments]);

  const clearSelection = useCallback(() => {
    setTextSel(null);
    setComposerOpen(false);
    window.getSelection()?.removeAllRanges();
  }, []);

  // The START + END cues and char range to persist. A single-cue selection has
  // `startSeg === endSeg`. With NO selection there is nothing to code/comment.
  const pending = useMemo(() => {
    if (!textSel) return null;
    const startSeg = segments[textSel.startSegIdx];
    const endSeg = segments[textSel.endSegIdx];
    if (!startSeg || !endSeg) return null;
    return {
      startSeg,
      endSeg,
      startChar: textSel.startChar,
      endChar: textSel.endChar,
      quoteText: textSel.quoteText,
      prefix: textSel.prefix,
      suffix: textSel.suffix,
    };
  }, [textSel, segments]);

  // --- Mutations ----------------------------------------------------------

  // After any annotation/comment mutation, refetch the active version's own
  // annotations + threads into STATE (both tabs). The old 'original'-tab branch
  // did router.refresh(), which re-passed the `myAnnotations` prop but never
  // synced it into the `useState(initialAnnotations)` — so a new highlight/comment
  // never entered state and never rendered until a manual reload (issue A).
  const afterAnnotationMutation = useCallback(async () => {
    await refreshActiveAnnotations();
  }, [refreshActiveAnnotations]);

  const handleDeleteAnnotation = useCallback(async (annotationId: string) => {
    setBusyId(annotationId);
    setError(null);
    try {
      await deleteAnnotation(annotationId);
      setOpenCommentAnnId((cur) => (cur === annotationId ? null : cur));
      await afterAnnotationMutation();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete annotation.');
    } finally {
      setBusyId(null);
    }
  }, [afterAnnotationMutation]);

  // Apply a code at the CURRENT video time. Anchors to the brushed selection when
  // one exists (`useSelection`), else to the cue playing now (whole-cue anchor) —
  // the coding-mode "search a code → it links to that time" gesture.
  const handleApplyCodeAt = useCallback(
    async (codeId: string, useSelection: boolean) => {
      if (!versionId || !codeId) return;
      setApplying(true);
      setError(null);
      try {
        if (useSelection && pending) {
          await addAnnotation({
            sessionId: id,
            versionId,
            segmentId: pending.startSeg.id,
            endSegmentId: pending.endSeg.id,
            charStart: pending.startChar,
            charEnd: pending.endChar,
            quoteText: pending.quoteText,
            prefix: pending.prefix,
            suffix: pending.suffix,
            tStartMs: pending.startSeg.startMs,
            tEndMs: pending.endSeg.endMs,
            kind: 'code',
            codeIds: [codeId],
          });
          clearSelection();
        } else {
          // No selection: anchor to the cue playing NOW. Use `activeIdx` (the
          // highlighted cue, from the UNROUNDED playhead) rather than re-deriving
          // from `currentMs` (floored to whole seconds) — the floored second can
          // fall into a different cue (or none) for sub-second/boundary cues, so
          // re-deriving would anchor the code to a cue other than the one shown
          // (or spuriously error). `activeIdx` makes the anchor match the highlight.
          const idx = activeIdx >= 0 ? activeIdx : findActiveIndex(segments, currentMs);
          const seg = idx >= 0 ? segments[idx] : null;
          if (!seg) {
            setError('No transcript is playing at the current time — scrub to a line first.');
            return;
          }
          await addAnnotation({
            sessionId: id,
            versionId,
            segmentId: seg.id,
            charStart: 0,
            charEnd: seg.text.length,
            quoteText: seg.text,
            prefix: '',
            suffix: '',
            tStartMs: seg.startMs,
            tEndMs: seg.endMs,
            kind: 'code',
            codeIds: [codeId],
          });
        }
        await afterAnnotationMutation();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to apply code.');
      } finally {
        setApplying(false);
      }
    },
    [versionId, pending, id, segments, currentMs, activeIdx, clearSelection, afterAnnotationMutation],
  );

  // --- Per-excerpt comments (margin) --------------------------------------

  const openCommentThread = useCallback(
    async (annotationId: string) => {
      setComposerOpen(false);
      setOpenCommentAnnId(annotationId);
      setCommentDraft('');
      setCommentError(null);
      try {
        const grouped = await listAnnotationComments([annotationId]);
        setComments((prev) => ({ ...prev, [annotationId]: grouped[annotationId] ?? [] }));
      } catch (e) {
        setCommentError(e instanceof Error ? e.message : 'Failed to load comments.');
      }
    },
    [],
  );

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
      await afterAnnotationMutation();
    } catch (e) {
      setCommentError(e instanceof Error ? e.message : 'Failed to add comment.');
    } finally {
      setCommentBusy(false);
    }
  }, [openCommentAnnId, commentDraft, afterAnnotationMutation]);

  // Comment on a FRESH selection: create a kind:'quote' anchor, post the first
  // comment, then open its thread card. (Google-Docs comment-on-selection.)
  const handleCommentOnSelection = useCallback(async () => {
    if (!pending || !versionId || selectionCommentDraft.trim() === '') return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      const ann = await addAnnotation({
        sessionId: id,
        versionId,
        segmentId: pending.startSeg.id,
        endSegmentId: pending.endSeg.id,
        charStart: pending.startChar,
        charEnd: pending.endChar,
        quoteText: pending.quoteText,
        prefix: pending.prefix,
        suffix: pending.suffix,
        tStartMs: pending.startSeg.startMs,
        tEndMs: pending.endSeg.endMs,
        kind: 'quote',
        codeIds: [],
      });
      await addAnnotationComment(ann.id, selectionCommentDraft.trim());
      setSelectionCommentDraft('');
      clearSelection();
      setComposerOpen(false);
      await afterAnnotationMutation();
      await openCommentThread(ann.id);
    } catch (e) {
      setCommentError(e instanceof Error ? e.message : 'Failed to comment on selection.');
    } finally {
      setCommentBusy(false);
    }
  }, [pending, versionId, selectionCommentDraft, id, clearSelection, afterAnnotationMutation, openCommentThread]);

  // ⌘⇧J — mark as IMPORTANT QUOTE. On an open thread, flip its anchor to
  // kind:'quote'. On a fresh selection (composer), create a quote anchor straight
  // away (posting the draft as the first comment if one is typed).
  const handleMarkQuote = useCallback(async () => {
    setCommentError(null);
    if (openCommentAnnId) {
      setCommentBusy(true);
      try {
        await setAnnotationKind(openCommentAnnId, 'quote');
        await afterAnnotationMutation();
      } catch (e) {
        setCommentError(e instanceof Error ? e.message : 'Failed to mark quote.');
      } finally {
        setCommentBusy(false);
      }
      return;
    }
    if (pending && versionId) {
      if (selectionCommentDraft.trim() !== '') {
        await handleCommentOnSelection();
        return;
      }
      setCommentBusy(true);
      try {
        await addAnnotation({
          sessionId: id,
          versionId,
          segmentId: pending.startSeg.id,
          endSegmentId: pending.endSeg.id,
          charStart: pending.startChar,
          charEnd: pending.endChar,
          quoteText: pending.quoteText,
          prefix: pending.prefix,
          suffix: pending.suffix,
          tStartMs: pending.startSeg.startMs,
          tEndMs: pending.endSeg.endMs,
          kind: 'quote',
          codeIds: [],
        });
        clearSelection();
        await afterAnnotationMutation();
      } catch (e) {
        setCommentError(e instanceof Error ? e.message : 'Failed to mark quote.');
      } finally {
        setCommentBusy(false);
      }
    }
  }, [openCommentAnnId, pending, versionId, selectionCommentDraft, id, clearSelection, afterAnnotationMutation, handleCommentOnSelection]);

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
        setCommentError(e instanceof Error ? e.message : 'Failed to update comment.');
      } finally {
        setCommentRowBusyId(null);
      }
    },
    [openCommentAnnId],
  );

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
        setCommentError(e instanceof Error ? e.message : 'Failed to delete comment.');
      } finally {
        setCommentRowBusyId(null);
      }
    },
    [openCommentAnnId, afterAnnotationMutation],
  );

  // Clicking a highlighted span opens its comment thread. In REVIEW mode the card
  // shows in the margin rail; in CODING mode (no gutter) it pops up in a floating
  // popover anchored at the click point.
  const openThreadForAnnotation = useCallback(
    (ann: MyAnnotationView, e?: React.MouseEvent) => {
      void openCommentThread(ann.id);
      if (mode === 'coding' && e) {
        setCommentPopoverPos({ x: e.clientX, y: e.clientY });
      }
    },
    [openCommentThread, mode],
  );

  // --- Phrase-search navigation -------------------------------------------
  const gotoMatch = useCallback(
    (delta: number) => {
      const n = searchMatches.length;
      if (n === 0) return;
      const base = safeMatchIdx < 0 ? 0 : safeMatchIdx;
      setCurrentMatchIdx(((base + delta) % n + n) % n);
    },
    [searchMatches.length, safeMatchIdx],
  );

  // Scroll the current match's cue into view as the user steps through matches.
  // scrollIntoView (not setState) in an effect is fine — only setState is banned.
  useEffect(() => {
    if (safeMatchIdx < 0) return;
    const mt = searchMatches[safeMatchIdx];
    if (mt) rowRefs.current[mt.segIdx]?.scrollIntoView({ block: 'center' });
  }, [safeMatchIdx, searchMatches]);

  // --- Keyboard control (⌘⌥M comment · ⌘⇧J quote · Esc close) -------------
  //
  // We match on `e.code` (the physical key), not `e.key`: on macOS ⌘⌥M / ⌘⇧J emit
  // dead/composed `key` values, so keying on `e.key` would silently miss them.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        setComposerOpen(false);
        setOpenCommentAnnId(null);
        setCommentPopoverPos(null);
        clearSelection();
        return;
      }
      // Comment + quote gestures are review-mode only.
      if (mode !== 'review' || !codingEnabled) return;
      if (e.metaKey && e.altKey && e.code === 'KeyM') {
        e.preventDefault();
        if (pending) {
          setOpenCommentAnnId(null);
          setComposerOpen(true);
          setTimeout(() => composerTextareaRef.current?.focus(), 0);
        }
      } else if (e.metaKey && e.shiftKey && e.code === 'KeyJ') {
        // ⌘⇧J: mark important quote (open thread → flip kind; selection → new quote).
        if (openCommentAnnId || pending) {
          e.preventDefault();
          void handleMarkQuote();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mode, codingEnabled, pending, openCommentAnnId, clearSelection, handleMarkQuote]);

  // --- Derived view helpers ----------------------------------------------

  // segment id → its index in `segments` (transcript order). Used to expand a
  // multi-cue annotation's start/end segment ids back into a covered index range.
  const segIndexById = useMemo(() => {
    const m = new Map<string, number>();
    segments.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [segments]);

  // Own annotations grouped by segment id → the highlights to render. A
  // single-segment annotation (`endSegmentId` null) is one highlight on its
  // segment; a MULTI-CUE annotation is expanded into one highlight per covered cue
  // (start cue from `charStart`, middle cues whole, end cue to `charEnd`) — all
  // sharing the annotation id. A multi-cue annotation whose end segment isn't in
  // the active version (e.g. after a version switch) falls back to a single-cue
  // highlight on the start segment so it never vanishes.
  const highlightsBySegment = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    const push = (segId: string, h: Highlight) => {
      const list = m.get(segId) ?? [];
      list.push(h);
      m.set(segId, list);
    };
    for (const a of myAnnotations) {
      const startIdx = segIndexById.get(a.segmentId);
      const endIdx = a.endSegmentId ? segIndexById.get(a.endSegmentId) : startIdx;
      if (
        startIdx === undefined ||
        endIdx === undefined ||
        endIdx < startIdx ||
        !a.endSegmentId ||
        a.endSegmentId === a.segmentId
      ) {
        // Single cue (or an unresolvable multi end → degrade to the start cue).
        push(a.segmentId, {
          annotationId: a.id,
          charStart: a.charStart,
          charEnd: a.charEnd,
          kind: a.kind,
        });
        continue;
      }
      for (const [segId, h] of expandRangeHighlights(
        a.id,
        a.kind,
        startIdx,
        a.charStart,
        endIdx,
        a.charEnd,
        segments,
      )) {
        push(segId, h);
      }
    }
    return m;
  }, [myAnnotations, segIndexById, segments]);

  // --- Live co-observation review markers (Task 5) ------------------------
  const anchorMs = useMemo(() => {
    if (!recordingStartedAt) return null;
    const ms = Date.parse(recordingStartedAt);
    return Number.isNaN(ms) ? null : ms;
  }, [recordingStartedAt]);

  // --- AI-chat replay alignment (chat-replay feature) ---------------------
  // ONE CLOCK: the chat reuses the SAME `anchorMs` the flags above derive — it
  // does NOT re-parse `recordingStartedAt`, so chat/flags/transcript share one
  // timeline. A null anchor (recording never anchored) yields no turns; the pane
  // then renders its "anchor not set" hint (gated on `anchorMs != null` below).
  const chatTurns = useMemo(
    () => (anchorMs == null ? [] : alignChat(chatMessages, anchorMs)),
    [chatMessages, anchorMs],
  );
  // The turn current at the playhead. `currentMs` is the existing second-rounded
  // playhead state (handleTimeUpdate), so the active turn advances ≤1×/s in lock-
  // step with the transcript's active cue — same playhead, same cadence.
  const chatActiveIndex = useMemo(
    () => activeChatIndex(chatTurns, currentMs),
    [chatTurns, currentMs],
  );

  // MEANINGFUL flags only (Change R3 drops empty "Note"/stale-event rows), each at
  // `createdAt − anchor` (pre-record flags clamp to 0), in time order.
  const flagMarkers = useMemo(() => {
    if (anchorMs === null) return [];
    return observations
      .filter(isMeaningfulObservation)
      .map((o) => {
        const createdMs = Date.parse(o.createdAt);
        if (Number.isNaN(createdMs)) return null;
        const offsetMs = Math.max(0, createdMs - anchorMs);
        return { obs: o, offsetMs };
      })
      .filter((m): m is { obs: ObservationView; offsetMs: number } => m !== null)
      .sort((a, b) => a.offsetMs - b.offsetMs);
  }, [observations, anchorMs]);

  const railSpanMs = useMemo(() => {
    const lastOffset = flagMarkers.length ? flagMarkers[flagMarkers.length - 1].offsetMs : 0;
    return Math.max(1, durationMs, lastOffset);
  }, [flagMarkers, durationMs]);

  // FLAG → TEXT highlights (Change R4): each flag tints the cue playing at its
  // offset with the flag's swatch color, so a flag connects to the words it was
  // logged against. Synthetic, non-clickable highlights keyed `flag:<obsId>`.
  //
  // We use `nearestCueIndex` (NOT `findActiveIndex`): a flag's record-relative time
  // rarely lands exactly inside a cue's span, so containment-only mapping silently
  // dropped flags that fell in inter-cue gaps. EVERY flag must map onto some text, so
  // a gap-falling flag attaches to its nearest cue by time. Only an empty transcript
  // yields no mapping (idx < 0).
  const flagHighlightsBySegment = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    for (const { obs, offsetMs } of flagMarkers) {
      const idx = nearestCueIndex(segments, offsetMs);
      if (idx < 0) continue;
      const seg = segments[idx];
      const list = m.get(seg.id) ?? [];
      list.push({
        annotationId: `flag:${obs.id}`,
        charStart: 0,
        charEnd: seg.text.length,
        kind: 'flag',
        // A guaranteed hex so the renderer can alpha-composite a TRANSLUCENT tint
        // (`hexWithAlpha`). A colorless flag (a bare note) falls back to neutral
        // gray — never the opaque `var(--foreground)`, which would black out the cue.
        color: obs.color ?? '#9ca3af',
      });
      m.set(seg.id, list);
    }
    return m;
  }, [flagMarkers, segments]);

  // Merge committed annotation highlights + flag highlights. The in-progress
  // selection is deliberately NOT woven in here: the persistent yellow highlight
  // appears only once the annotation is committed (comment saved / quote marked /
  // code applied). While composing, the cue is shown by the browser's native
  // selection plus the quote preview in the comment card — no synthetic brush, so
  // nothing paints until there's a real annotation to paint.
  const PENDING_ANN_ID = '__pending__';
  const highlightsBySegmentAll = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    const segIds = new Set<string>([
      ...highlightsBySegment.keys(),
      ...flagHighlightsBySegment.keys(),
    ]);
    for (const segId of segIds) {
      m.set(segId, [
        ...(flagHighlightsBySegment.get(segId) ?? []),
        ...(highlightsBySegment.get(segId) ?? []),
      ]);
    }
    // Phrase-search matches paint orange (the current match brighter), like flags:
    // non-clickable, background-only. Layered ON TOP so a match is visible even over
    // an annotated span's non-overlapping chars.
    searchMatches.forEach((mt, i) => {
      const seg = segments[mt.segIdx];
      if (!seg) return;
      const list = m.get(seg.id) ?? [];
      list.push({
        annotationId: `search:${i}`,
        charStart: mt.charStart,
        charEnd: mt.charEnd,
        kind: i === safeMatchIdx ? 'search-current' : 'search',
      });
      m.set(seg.id, list);
    });
    return m;
  }, [highlightsBySegment, flagHighlightsBySegment, searchMatches, safeMatchIdx, segments]);

  const annById = useMemo(() => {
    const m = new Map<string, MyAnnotationView>();
    for (const a of myAnnotations) m.set(a.id, a);
    return m;
  }, [myAnnotations]);

  const commentedAnnIds = useMemo(() => {
    const s = new Set<string>();
    for (const a of myAnnotations) if (a.commentCount > 0) s.add(a.id);
    for (const [annId, list] of Object.entries(comments)) {
      if (list.length > 0) s.add(annId);
      else s.delete(annId);
    }
    return s;
  }, [myAnnotations, comments]);

  // --- Speaker-turn grouping ----------------------------------------------
  const turns = useMemo(() => groupIntoTurns(segments), [segments]);

  // --- Current event (Change R2) ------------------------------------------
  // The auto-derived episode now playing: the last one whose start is ≤ currentMs.
  // The episodes are time-ordered (sorted defensively). `-1` before the first one.
  const orderedEpisodes = useMemo(
    () => [...sessionEpisodes].sort((a, b) => a.tStartMs - b.tStartMs),
    [sessionEpisodes],
  );
  const currentEpisodeIdx = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < orderedEpisodes.length; i++) {
      if (orderedEpisodes[i].tStartMs <= currentMs) idx = i;
      else break;
    }
    return idx;
  }, [orderedEpisodes, currentMs]);

  // Keep the current event scrolled into view inside its small box.
  useEffect(() => {
    currentEventRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentEpisodeIdx]);

  // --- Comment-margin anchoring (flow gutter, no measurement) -------------
  // The review-mode comment card renders in the GUTTER of the turn that holds the
  // active anchor cue — so it aligns automatically and scrolls with the content,
  // no offsetTop math (and no setState-in-effect). `segIndexById` (above) maps the
  // anchor's segment id → seg index → turn index.
  const turnIndexBySegIdx = useMemo(() => {
    const m = new Map<number, number>();
    turns.forEach((t, ti) => t.segIndices.forEach((si) => m.set(si, ti)));
    return m;
  }, [turns]);

  const openCommentAnn = openCommentAnnId ? annById.get(openCommentAnnId) ?? null : null;

  const canCommentOnSelection =
    !!pending && !!versionId && selectionCommentDraft.trim() !== '' && !commentBusy;

  const railEnabled = mode === 'review' && !editing && codingEnabled;
  // The TRANSIENT composer card (a fresh, uncommitted selection) — not yet a
  // persisted annotation, so it isn't in `railCardsByTurn`. Its anchor turn is the
  // selection's start cue's turn; default to the first turn if it can't be resolved.
  const composerOpenForRail = railEnabled && composerOpen && !openCommentAnn;
  const composerAnchorTurnIdx =
    composerOpenForRail && textSel
      ? turnIndexBySegIdx.get(textSel.startSegIdx) ?? 0
      : null;

  // PERSISTENT rail cards: one card per annotation that has comments OR is a quote,
  // bucketed into its anchor turn's gutter (issue C). Pure layout math in
  // lib/transcript/rail (unit-tested).
  const railCardsByTurn = useMemo(
    () =>
      railEnabled
        ? cardsByTurn(myAnnotations, commentedAnnIds, segIndexById, turnIndexBySegIdx)
        : new Map<number, RailCard[]>(),
    [railEnabled, myAnnotations, commentedAnnIds, segIndexById, turnIndexBySegIdx],
  );

  // Close any open card / composer and clear the selection. Shared by every card's
  // close button.
  const closeCard = useCallback(() => {
    setComposerOpen(false);
    setOpenCommentAnnId(null);
    setCommentError(null);
    setCommentDraft('');
    setSelectionCommentDraft('');
    setCommentPopoverPos(null);
    clearSelection();
  }, [clearSelection]);

  // Render the stack of cards hanging in turn `turnIdx`'s gutter: every persistent
  // card anchored to this turn, plus the transient composer when its anchor turn
  // matches. Cards are absolutely positioned in the gutter cell (so they never grow
  // the transcript row / misalign text); each is offset down a little so collapsed
  // previews fan out and stay individually clickable. The OPEN card (composer or
  // the open thread) is expanded and gets the top z-index so it sits ABOVE the rest
  // (issue D). A bare-preview card shows a one-line summary; clicking it opens it.
  const renderGutter = useCallback(
    (turnIdx: number): React.ReactNode => {
      if (!railEnabled) return null;
      const cards = railCardsByTurn.get(turnIdx) ?? [];
      const showComposerHere = composerOpenForRail && composerAnchorTurnIdx === turnIdx;
      if (cards.length === 0 && !showComposerHere) return null;

      // Collapsed previews stack with a small vertical step; the open/composer card
      // jumps to the top z-index. z-index base leaves headroom under the open card.
      const STEP_REM = 2.5;
      const nodes: React.ReactNode[] = [];

      cards.forEach((card, i) => {
        const ann = annById.get(card.annId);
        if (!ann) return;
        const isOpen = openCommentAnnId === card.annId;
        const top = isOpen ? 0 : i * STEP_REM;
        const z = isOpen ? 40 : 10 + i;
        const thread = comments[card.annId] ?? [];
        const previewText =
          thread.length > 0 ? thread[thread.length - 1].body : ann.kind === 'quote' ? 'Quote' : '';
        nodes.push(
          <div
            key={card.annId}
            className="absolute left-0 w-60"
            style={{ top: `${top}rem`, zIndex: z }}
          >
            {isOpen ? (
              <CommentCard
                composerMode={false}
                pendingQuote={null}
                openCommentAnn={ann}
                openThread={thread}
                commentError={commentError}
                commentDraft={commentDraft}
                selectionCommentDraft={selectionCommentDraft}
                commentBusy={commentBusy}
                commentRowBusyId={commentRowBusyId}
                canCommentOnSelection={canCommentOnSelection}
                composerTextareaRef={composerTextareaRef}
                busyId={busyId}
                formatTime={formatTime}
                formatCommentTime={formatCommentTime}
                onClose={closeCard}
                onSeek={seekTo}
                onChangeCommentDraft={setCommentDraft}
                onChangeSelectionDraft={setSelectionCommentDraft}
                onAddComment={handleAddComment}
                onCommentOnSelection={handleCommentOnSelection}
                onMarkQuote={handleMarkQuote}
                onResolveComment={handleResolveComment}
                onDeleteComment={handleDeleteComment}
                onDeleteAnnotation={handleDeleteAnnotation}
              />
            ) : (
              <CommentPreviewCard
                kind={ann.kind}
                previewText={previewText}
                quoteText={ann.quoteText}
                onOpen={() => openThreadForAnnotation(ann)}
              />
            )}
          </div>,
        );
      });

      if (showComposerHere) {
        nodes.push(
          <div key="__composer__" className="absolute left-0 top-0 w-60" style={{ zIndex: 50 }}>
            <CommentCard
              composerMode
              pendingQuote={pending?.quoteText ?? null}
              openCommentAnn={null}
              openThread={[]}
              commentError={commentError}
              commentDraft={commentDraft}
              selectionCommentDraft={selectionCommentDraft}
              commentBusy={commentBusy}
              commentRowBusyId={commentRowBusyId}
              canCommentOnSelection={canCommentOnSelection}
              composerTextareaRef={composerTextareaRef}
              busyId={busyId}
              formatTime={formatTime}
              formatCommentTime={formatCommentTime}
              onClose={closeCard}
              onSeek={seekTo}
              onChangeCommentDraft={setCommentDraft}
              onChangeSelectionDraft={setSelectionCommentDraft}
              onAddComment={handleAddComment}
              onCommentOnSelection={handleCommentOnSelection}
              onMarkQuote={handleMarkQuote}
              onResolveComment={handleResolveComment}
              onDeleteComment={handleDeleteComment}
              onDeleteAnnotation={handleDeleteAnnotation}
            />
          </div>,
        );
      }

      return <>{nodes}</>;
    },
    [
      railEnabled,
      railCardsByTurn,
      composerOpenForRail,
      composerAnchorTurnIdx,
      annById,
      openCommentAnnId,
      comments,
      commentError,
      commentDraft,
      selectionCommentDraft,
      commentBusy,
      commentRowBusyId,
      canCommentOnSelection,
      busyId,
      pending,
      closeCard,
      seekTo,
      handleAddComment,
      handleCommentOnSelection,
      handleMarkQuote,
      handleResolveComment,
      handleDeleteComment,
      handleDeleteAnnotation,
      openThreadForAnnotation,
    ],
  );

  // Props shared by both modes' transcript render. Review mode adds a gutter that
  // hosts the comment card; coding mode renders full-width with no gutter.
  const commonTranscriptProps = {
    versionBusy,
    segments,
    turns,
    isCleanedActive,
    editing,
    codingEnabled,
    activeIdx,
    highlightsBySegmentAll,
    annById,
    commentedAnnIds,
    openCommentAnnId,
    pendingAnnId: PENDING_ANN_ID,
    rowRefs,
    onSeek: seekTo,
    onFocusAnnotation: openThreadForAnnotation,
    onSegmentTextCommit: handleSegmentTextCommit,
  };

  // Hoisted once so the 50/50 split is defined in ONE place and rendered
  // identically in both the review and coding transcript branches: the
  // transcript's height (full vs. half when the chat pane is open) and the
  // chat-replay pane element itself.
  const transcriptHeightClass = showChat ? 'h-[40vh]' : 'h-[80vh]';
  const chatPane = showChat ? (
    <ChatReplayPane
      turns={chatTurns}
      activeIndex={chatActiveIndex}
      onSeek={seekTo}
      fmtTime={formatTime}
      hasMessages={chatMessages.length > 0}
      anchorResolved={anchorMs != null}
      className="mt-2 h-[40vh] overflow-y-auto pr-3"
    />
  ) : null;

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-medium tracking-tight">
            Participant{' '}
            <span className="font-mono text-foreground/50">({pidLabel})</span>
          </h1>
          <div className="flex items-center gap-2">
            {codingEnabled && (
              <div
                role="tablist"
                aria-label="Player mode"
                className="flex rounded border border-foreground/20 text-xs"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'review'}
                  onClick={() => setMode('review')}
                  className={`rounded-l px-3 py-1 ${
                    mode === 'review'
                      ? 'bg-foreground text-background'
                      : 'text-foreground/70 hover:text-foreground'
                  }`}
                >
                  Review
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'coding'}
                  onClick={() => setMode('coding')}
                  className={`rounded-r px-3 py-1 ${
                    mode === 'coding'
                      ? 'bg-foreground text-background'
                      : 'text-foreground/70 hover:text-foreground'
                  }`}
                >
                  Coding
                </button>
              </div>
            )}
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
        {/* LEFT (1/3, shared across modes): video + current-event + flags. */}
        <div className="space-y-4 lg:col-span-1">
          <video
            ref={videoRef}
            controls
            preload="metadata"
            src={`/api/media/${id}/video`}
            onTimeUpdate={handleTimeUpdate}
            className="w-full bg-black"
          />

          {/* Current event (R2): the auto-derived episode now playing, in a small
              scrollable box (current + next visible, scroll for the rest). */}
          {codingEnabled && orderedEpisodes.length > 0 && (
            <section className="rounded border border-foreground/15 p-3">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold">Current event</h2>
                <Link
                  href="/episodes"
                  className="ml-auto text-xs text-foreground/50 underline hover:text-foreground"
                  title="Manage the codebook's preset events"
                >
                  Manage presets
                </Link>
              </div>
              <ul className="max-h-[4.5rem] divide-y divide-foreground/10 overflow-y-auto">
                {orderedEpisodes.map((m, i) => {
                  const isCurrent = i === currentEpisodeIdx;
                  return (
                    <li
                      key={m.id}
                      ref={isCurrent ? currentEventRef : undefined}
                      className={`flex items-center gap-2 py-1.5 text-sm ${
                        isCurrent ? 'bg-foreground/[0.06]' : ''
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => seekTo(m.tStartMs)}
                        className="flex-1 text-left hover:underline"
                        title="Seek to this event"
                      >
                        {isCurrent && <span className="mr-1 text-emerald-600" aria-hidden>▸</span>}
                        <span className={isCurrent ? 'font-semibold' : ''}>{m.episodeName}</span>{' '}
                        <span className="font-mono text-xs text-foreground/50">
                          [{formatTime(m.tStartMs)}]
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Flags on timeline (R1 collapse + R3 filter). The marker bar stays;
              the list scrolls at ~8 rows so the code panel below is reachable. */}
          {flagMarkers.length > 0 && (
            <section
              aria-label="Live flags on the timeline"
              className="rounded border border-foreground/15 p-3"
            >
              <h2 className="mb-2 text-sm font-semibold">
                Flags on timeline
                <span className="ml-1 font-normal text-foreground/40">
                  · {flagMarkers.length} flag{flagMarkers.length === 1 ? '' : 's'}
                </span>
              </h2>
              <div
                className="relative h-7 w-full rounded bg-foreground/[0.06]"
                role="group"
                aria-label="Flag markers"
              >
                {flagMarkers.map(({ obs, offsetMs }) => {
                  const leftPct = Math.min(100, (offsetMs / railSpanMs) * 100);
                  const label = observationLabel(obs);
                  return (
                    <button
                      key={obs.id}
                      type="button"
                      onClick={() => seekTo(offsetMs)}
                      title={`[${formatTime(offsetMs)}] ${label}${obs.body ? ` — ${obs.body}` : ''}`}
                      aria-label={`Seek to flag ${label} at ${formatTime(offsetMs)}`}
                      style={{ left: `${leftPct}%`, backgroundColor: observationColor(obs) }}
                      className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background/40 hover:h-5 hover:w-2"
                    />
                  );
                })}
              </div>

              <ul className="mt-3 max-h-64 divide-y divide-foreground/10 overflow-y-auto">
                {flagMarkers.map(({ obs, offsetMs }) => {
                  const label = observationLabel(obs);
                  return (
                    <li key={obs.id} className="flex items-start gap-2 py-1.5 text-sm">
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
                            <span className="text-foreground/70">{' — '}{obs.body}</span>
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
            </section>
          )}
        </div>

        {/* MIDDLE (coding mode only, 1/3): fuzzy code search + new-code panel. */}
        {codingEnabled && mode === 'coding' && (
          <div className="space-y-4 lg:col-span-1">
            <CodingPanel
              codes={codes}
              currentMs={currentMs}
              pending={
                pending
                  ? { quoteText: pending.quoteText, tStartMs: pending.startSeg.startMs }
                  : null
              }
              applying={applying}
              onApply={handleApplyCodeAt}
              onClearSelection={clearSelection}
              formatTime={formatTime}
            />
            <SessionCodeCreator
              codebookId={codebookId}
              facets={facets}
              labels={labels}
              studyLabel={collection}
              onCreated={() => router.refresh()}
            />
          </div>
        )}

        {/* RIGHT: transcript (2/3 in review with a comment margin; 1/3 in coding). */}
        <div className={mode === 'review' ? 'lg:col-span-2' : 'lg:col-span-1'}>
          {/* Version tabs + edit/sync toggles. */}
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
                <span className="ml-1 font-normal text-foreground/40">· verbatim, read-only</span>
              ) : (
                <span className="ml-1 font-normal text-foreground/40">· cleaned</span>
              )}
            </h2>
            <div className="flex items-center gap-1">
              {isCleanedActive && versionId && (
                <button
                  type="button"
                  onClick={() => setEditing((e) => !e)}
                  aria-pressed={editing}
                  title={editing ? 'Stop editing the cleaned transcript' : 'Edit the cleaned transcript text'}
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
                title={synced ? 'Transcript follows the video (click to stop)' : 'Transcript is not following the video (click to follow)'}
                className={`rounded border px-2 py-1 text-xs ${
                  synced
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/30 text-foreground/70 hover:text-foreground'
                }`}
              >
                {synced ? 'Sync: on' : 'Sync: off'}
              </button>
              <button
                type="button"
                onClick={() => setShowChat((c) => !c)}
                aria-pressed={showChat}
                title={showChat ? 'Hide the AI-chat replay (click to hide)' : 'Show the participant’s AI chat aligned to the timeline'}
                className={`rounded border px-2 py-1 text-xs ${
                  showChat
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/30 text-foreground/70 hover:text-foreground'
                }`}
              >
                Chat
              </button>
            </div>
          </div>

          {versionError && (
            <p className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300">
              {versionError}
            </p>
          )}

          {/* Phrase search over the transcript: paints matches orange (current one
              brighter), steps through with ↑/↓ / Enter, scrolls the match into view. */}
          <div className="mb-2 flex items-center gap-2">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  gotoMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === 'Escape') {
                  setSearchQuery('');
                }
              }}
              placeholder="Search transcript…"
              aria-label="Search the transcript for a phrase"
              className="min-w-0 flex-1 rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
            />
            {searchQuery.trim().length >= 2 && (
              <>
                <span className="shrink-0 font-mono text-xs text-foreground/50" aria-live="polite">
                  {searchMatches.length === 0 ? '0/0' : `${safeMatchIdx + 1}/${searchMatches.length}`}
                </span>
                <button
                  type="button"
                  onClick={() => gotoMatch(-1)}
                  disabled={searchMatches.length === 0}
                  aria-label="Previous match"
                  title="Previous match (⇧⏎)"
                  className="rounded border border-foreground/20 px-1.5 py-1 text-xs text-foreground/70 hover:text-foreground disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => gotoMatch(1)}
                  disabled={searchMatches.length === 0}
                  aria-label="Next match"
                  title="Next match (⏎)"
                  className="rounded border border-foreground/20 px-1.5 py-1 text-xs text-foreground/70 hover:text-foreground disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  title="Clear"
                  className="rounded border border-foreground/20 px-1.5 py-1 text-xs text-foreground/50 hover:text-foreground"
                >
                  ✕
                </button>
              </>
            )}
          </div>

          {isCleanedActive && !versionId ? (
            <div className="rounded border border-foreground/15 p-4 text-sm text-foreground/70">
              <p className="mb-3">
                No cleaned copy exists yet. Create one to get a readable, editable
                transcript for navigation and quoting. The original verbatim
                transcript stays untouched.
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
          ) : mode === 'review' ? (
            /* REVIEW: flowing transcript with a Google-Docs comment GUTTER. Each
               turn reserves a right gutter; the active card renders in the anchor
               turn's gutter (absolutely placed so it never grows the row), so it
               aligns to its excerpt and scrolls with the content — no measurement. */
            <>
              {codingEnabled && (
                <p className="mb-1 text-xs text-foreground/40">
                  Select text →{' '}
                  <kbd className="rounded border border-foreground/20 bg-foreground/5 px-1 font-mono">⌘⌥M</kbd>{' '}
                  to comment ·{' '}
                  <kbd className="rounded border border-foreground/20 bg-foreground/5 px-1 font-mono">⌘⇧J</kbd>{' '}
                  to mark an important quote.
                </p>
              )}
              <div
                ref={transcriptRef}
                onMouseUp={codingEnabled && !editing ? handleTranscriptMouseUp : undefined}
                style={{ scrollbarGutter: 'stable' }}
                className={`relative overflow-y-auto pr-3 ${transcriptHeightClass}`}
              >
                <TranscriptBody
                  {...commonTranscriptProps}
                  renderGutter={renderGutter}
                />
              </div>
              {chatPane}
            </>
          ) : (
            /* CODING: full-width transcript column, no comment gutter. */
            <>
              <div
                ref={transcriptRef}
                onMouseUp={codingEnabled && !editing ? handleTranscriptMouseUp : undefined}
                style={{ scrollbarGutter: 'stable' }}
                className={`relative overflow-y-auto pr-3 ${transcriptHeightClass}`}
              >
                <TranscriptBody {...commonTranscriptProps} />
              </div>
              {chatPane}
            </>
          )}
        </div>
      </div>

      {/* CODING-mode comment popover: clicking a highlighted span opens its thread in
          a floating card at the click point (coding mode has no comment gutter). A
          transparent backdrop closes it on an outside click. */}
      {mode === 'coding' && openCommentAnn && commentPopoverPos && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeCard} aria-hidden />
          <div
            className="fixed z-50 w-60"
            style={{
              left: Math.min(
                commentPopoverPos.x,
                (typeof window !== 'undefined' ? window.innerWidth : 9999) - 248,
              ),
              top: Math.min(
                commentPopoverPos.y,
                (typeof window !== 'undefined' ? window.innerHeight : 9999) - 120,
              ),
            }}
          >
            <CommentCard
              composerMode={false}
              pendingQuote={null}
              openCommentAnn={openCommentAnn}
              openThread={comments[openCommentAnn.id] ?? []}
              commentError={commentError}
              commentDraft={commentDraft}
              selectionCommentDraft={selectionCommentDraft}
              commentBusy={commentBusy}
              commentRowBusyId={commentRowBusyId}
              canCommentOnSelection={canCommentOnSelection}
              composerTextareaRef={composerTextareaRef}
              busyId={busyId}
              formatTime={formatTime}
              formatCommentTime={formatCommentTime}
              onClose={closeCard}
              onSeek={seekTo}
              onChangeCommentDraft={setCommentDraft}
              onChangeSelectionDraft={setSelectionCommentDraft}
              onAddComment={handleAddComment}
              onCommentOnSelection={handleCommentOnSelection}
              onMarkQuote={handleMarkQuote}
              onResolveComment={handleResolveComment}
              onDeleteComment={handleDeleteComment}
              onDeleteAnnotation={handleDeleteAnnotation}
            />
          </div>
        </>
      )}
    </main>
  );
}

/**
 * The shared transcript render — one flowing block per speaker TURN (no cell
 * borders, no boxes; Change R5/R7). The speaker label and a single `[mm:ss]` seek
 * render once per turn; the turn's cues flow INLINE in one selectable `<p>`. Each
 * cue keeps its OWN `data-seg-idx` span and `rowRefs` entry so sub-segment
 * selection anchoring, per-cue highlights, and the active-cue scroll are unchanged.
 *
 * Edit mode (cleaned tab + Edit on) renders the SAME flowing paragraph, but each
 * cue is an inline `contentEditable` span (Change R6 — continuous, not stacked
 * boxes), committing per-cue on blur so cue boundaries (and therefore timing +
 * anchors) survive.
 */
function TranscriptBody({
  versionBusy,
  segments,
  turns,
  isCleanedActive,
  editing,
  codingEnabled,
  activeIdx,
  highlightsBySegmentAll,
  annById,
  commentedAnnIds,
  openCommentAnnId,
  pendingAnnId,
  rowRefs,
  onSeek,
  onFocusAnnotation,
  onSegmentTextCommit,
  renderGutter,
}: {
  versionBusy: boolean;
  segments: CloudSegment[];
  turns: ReturnType<typeof groupIntoTurns>;
  isCleanedActive: boolean;
  editing: boolean;
  codingEnabled: boolean;
  activeIdx: number;
  highlightsBySegmentAll: Map<string, Highlight[]>;
  annById: Map<string, MyAnnotationView>;
  commentedAnnIds: Set<string>;
  openCommentAnnId: string | null;
  pendingAnnId: string;
  rowRefs: React.RefObject<(HTMLElement | null)[]>;
  onSeek: (ms: number) => void;
  onFocusAnnotation: (ann: MyAnnotationView, e: React.MouseEvent) => void;
  onSegmentTextCommit: (segmentId: string, text: string) => void;
  /** Review mode: render the comment card into a turn's right gutter (the anchor
   *  turn returns the card, others null). Omitted in coding mode (no gutter). */
  renderGutter?: (turnIdx: number) => React.ReactNode;
}) {
  if (versionBusy) {
    return <p className="p-2 text-sm text-foreground/60">Loading…</p>;
  }
  if (segments.length === 0) {
    return <p className="p-2 text-sm text-foreground/60">No transcript</p>;
  }
  return (
    <div className="py-2">
      {turns.map((turn, turnIdx) => {
        const firstSeg = segments[turn.segIndices[0]];
        const speaker = firstSeg?.speaker ?? null;
        const turnInner = (
          <div className="flex items-start gap-1.5">
            <button
              type="button"
              onClick={() => onSeek(turn.startMs)}
              title="Seek to here"
              className="mt-px shrink-0 font-mono text-xs text-foreground/40 hover:text-foreground hover:underline"
            >
              [{formatTime(turn.startMs)}]
            </button>

            {isCleanedActive && editing ? (
              /* Continuous inline-editable cues (R6). */
              <p className="flex-1 text-left">
                {speaker && <span className="mr-1.5 font-semibold">{speaker}:</span>}
                {turn.segIndices.map((si, posInTurn) => {
                  const seg = segments[si];
                  return (
                    <span key={seg.id}>
                      {posInTurn > 0 ? ' ' : null}
                      <InlineCueEditor
                        key={`${seg.id}:${seg.text}`}
                        initialText={seg.text}
                        onCommit={(t) => onSegmentTextCommit(seg.id, t)}
                      />
                    </span>
                  );
                })}
              </p>
            ) : (
              /* Read/code: the turn's cues inline in one selectable `<p>`. */
              <p className="flex-1 select-text text-left">
                {speaker && <span className="mr-1.5 font-semibold">{speaker}:</span>}
                {turn.segIndices.map((si, posInTurn) => {
                  const seg = segments[si];
                  const highlights = highlightsBySegmentAll.get(seg.id) ?? [];
                  const active = si === activeIdx;
                  return (
                    <span key={seg.id}>
                      {posInTurn > 0 ? ' ' : null}
                      <span
                        data-seg-idx={si}
                        ref={(el) => {
                          rowRefs.current[si] = el;
                        }}
                        className={`text-foreground/80 ${active ? 'rounded-sm bg-sky-200/70 dark:bg-sky-400/25' : ''}`}
                      >
                        {codingEnabled && highlights.length > 0
                          ? renderHighlightedText(
                              seg.text,
                              highlights,
                              annById,
                              onFocusAnnotation,
                              commentedAnnIds,
                              openCommentAnnId,
                              pendingAnnId,
                            )
                          : seg.text}
                      </span>
                    </span>
                  );
                })}
              </p>
            )}
          </div>
        );

        const gutterNode = renderGutter ? renderGutter(turnIdx) : null;
        return (
          <div key={firstSeg?.id ?? turnIdx} className="mb-3 text-sm leading-relaxed">
            {renderGutter ? (
              /* Text + a right comment GUTTER (lg+). `renderGutter` returns the
                 turn's cards already absolutely positioned inside this relative
                 cell, so they never grow the row (text stays aligned) and they
                 scroll with the transcript (the cell is in flow). */
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,42rem)_16rem]">
                {turnInner}
                {/* data-comment-card: the selection mouseup handler ignores events
                    from inside the gutter so clicking the composer doesn't clear the
                    pending selection (which would unanchor + hide the composer). */}
                <div data-comment-card className="relative hidden lg:block">{gutterNode}</div>
              </div>
            ) : (
              turnInner
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The single comment card shown in the review-mode margin — a Google-Docs comment
 * card. Two faces:
 *  • COMPOSER (a fresh selection, no annotation yet): excerpt + a draft textarea +
 *    Comment/Cancel. ⌘⌥M opened it; ⌘⇧J (handled by the parent) marks an important
 *    quote. Submitting creates a quote anchor + first comment.
 *  • THREAD (an existing excerpt): excerpt + codes + the comment thread + an
 *    add-comment input + "Mark quote" + delete-excerpt.
 */
function CommentCard({
  composerMode,
  pendingQuote,
  openCommentAnn,
  openThread,
  commentError,
  commentDraft,
  selectionCommentDraft,
  commentBusy,
  commentRowBusyId,
  canCommentOnSelection,
  composerTextareaRef,
  busyId,
  formatTime: fmtTime,
  formatCommentTime: fmtCommentTime,
  onClose,
  onSeek,
  onChangeCommentDraft,
  onChangeSelectionDraft,
  onAddComment,
  onCommentOnSelection,
  onMarkQuote,
  onResolveComment,
  onDeleteComment,
  onDeleteAnnotation,
}: {
  composerMode: boolean;
  pendingQuote: string | null;
  openCommentAnn: MyAnnotationView | null;
  openThread: AnnotationCommentView[];
  commentError: string | null;
  commentDraft: string;
  selectionCommentDraft: string;
  commentBusy: boolean;
  commentRowBusyId: string | null;
  canCommentOnSelection: boolean;
  composerTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  busyId: string | null;
  formatTime: (ms: number) => string;
  formatCommentTime: (iso: string) => string;
  onClose: () => void;
  onSeek: (ms: number) => void;
  onChangeCommentDraft: (v: string) => void;
  onChangeSelectionDraft: (v: string) => void;
  onAddComment: () => void;
  onCommentOnSelection: () => void;
  onMarkQuote: () => void;
  onResolveComment: (id: string, resolved: boolean) => void;
  onDeleteComment: (id: string) => void;
  onDeleteAnnotation: (id: string) => void;
}) {
  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-foreground/20 bg-background shadow-lg p-2">
      <div className="mb-1.5 flex items-start gap-2">
        <h2 className="text-xs font-semibold">
          {composerMode ? 'Comment' : 'Comments'}
          <span className="ml-1 font-normal text-foreground/40">
            on {composerMode ? 'selection' : 'excerpt'}
          </span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto text-foreground/40 hover:text-foreground"
        >
          {'✕'}
        </button>
      </div>

      {composerMode ? (
        <>
          {pendingQuote && (
            <div className="mb-1.5 rounded border border-foreground/10 bg-background/40 px-2 py-1 text-xs italic text-foreground/80">
              “{pendingQuote.length > 100 ? pendingQuote.slice(0, 100) + '…' : pendingQuote}”
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
            onChange={(e) => onChangeSelectionDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits; Shift+Enter inserts a newline. Guard empty/
              // whitespace and IME composition (a composing Enter commits the IME).
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (canCommentOnSelection) onCommentOnSelection();
              }
            }}
            placeholder="Comment… (Enter to send · ⇧⏎ newline)"
            rows={2}
            className="mb-2 w-full resize-none rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
            aria-label="Comment on selection"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onMarkQuote}
              disabled={commentBusy}
              title="Mark this selection as an important quote (⌘⇧J)"
              className="rounded border border-amber-500/60 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-500/10 disabled:opacity-40 dark:text-amber-300"
            >
              Mark quote ❝
            </button>
            <button
              type="button"
              onClick={onCommentOnSelection}
              disabled={!canCommentOnSelection}
              className="rounded bg-sky-600 px-2.5 py-1 text-xs text-white disabled:opacity-40"
            >
              {commentBusy ? 'Commenting…' : 'Comment'}
            </button>
          </div>
        </>
      ) : openCommentAnn ? (
        <>
          <div className="mb-1.5 rounded border border-foreground/10 bg-background/40 px-2 py-1 text-xs">
            <button
              type="button"
              onClick={() => onSeek(openCommentAnn.tStartMs)}
              className="font-mono text-xs text-foreground/50 hover:underline"
              title="Seek to here"
            >
              [{fmtTime(openCommentAnn.tStartMs)}]
            </button>{' '}
            <span className="italic text-foreground/80">
              “{openCommentAnn.quoteText ?? '(whole segment)'}”
            </span>
            {openCommentAnn.kind === 'quote' && (
              <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">· quote</span>
            )}
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

          {openThread.length === 0 ? (
            <p className="mb-2 text-sm text-foreground/50">No comments yet. Start the thread below.</p>
          ) : (
            <ul className="mb-1.5 divide-y divide-foreground/10">
              {openThread.map((c) => (
                <li key={c.id} className="py-1 text-xs">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold">{c.authorName}</span>
                    <span className="font-mono text-xs text-foreground/40">
                      {fmtCommentTime(c.createdAt)}
                    </span>
                    {c.resolved && (
                      <span className="rounded bg-emerald-500/15 px-1 text-xs text-emerald-700 dark:text-emerald-300">
                        resolved
                      </span>
                    )}
                    <span className="ml-auto flex gap-2">
                      <button
                        type="button"
                        onClick={() => onResolveComment(c.id, !c.resolved)}
                        disabled={commentRowBusyId === c.id}
                        className="text-xs text-foreground/50 underline hover:text-foreground disabled:opacity-40"
                      >
                        {c.resolved ? 'Re-open' : 'Resolve'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteComment(c.id)}
                        disabled={commentRowBusyId === c.id}
                        aria-label="Delete comment"
                        className="text-foreground/40 hover:text-red-500 disabled:opacity-40"
                      >
                        {'✕'}
                      </button>
                    </span>
                  </div>
                  <p className={`mt-0.5 whitespace-pre-wrap text-foreground/80 ${c.resolved ? 'line-through opacity-60' : ''}`}>
                    {c.body}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-start gap-2">
            <textarea
              value={commentDraft}
              onChange={(e) => onChangeCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits; Shift+Enter inserts a newline. Guard empty/
                // whitespace and IME composition.
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  if (commentDraft.trim() !== '' && !commentBusy) onAddComment();
                }
              }}
              placeholder="Add a comment… (Enter to send · ⇧⏎ newline)"
              rows={2}
              className="flex-1 resize-none rounded border border-foreground/20 bg-transparent px-2 py-1 text-xs"
              aria-label="Add a comment"
            />
            <button
              type="button"
              onClick={onAddComment}
              disabled={commentDraft.trim() === '' || commentBusy}
              className="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-40"
            >
              {commentBusy ? 'Saving…' : 'Comment'}
            </button>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2 border-t border-foreground/10 pt-2">
            <button
              type="button"
              onClick={onMarkQuote}
              disabled={commentBusy || openCommentAnn.kind === 'quote'}
              title="Mark this excerpt as an important quote (⌘⇧J)"
              className="rounded border border-amber-500/60 px-2 py-1 text-xs text-amber-700 hover:bg-amber-500/10 disabled:opacity-40 dark:text-amber-300"
            >
              {openCommentAnn.kind === 'quote' ? 'Quote ❝' : 'Mark quote ❝'}
            </button>
            <button
              type="button"
              onClick={() => onDeleteAnnotation(openCommentAnn.id)}
              disabled={busyId === openCommentAnn.id}
              className="text-xs text-foreground/40 underline hover:text-red-500 disabled:opacity-40"
            >
              Delete excerpt
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The COLLAPSED face of a rail card (issue C): a compact, unobtrusive preview for a
 * commented/quoted excerpt that is NOT the currently-open one. Shows a one-line
 * preview (the latest comment, or "Quote" for an uncommented quote) above the
 * excerpt. Clicking anywhere opens the full thread (`onOpen` → `openCommentThread`),
 * which expands this annotation's card and elevates it above the rest (issue D).
 */
function CommentPreviewCard({
  kind,
  previewText,
  quoteText,
  onOpen,
}: {
  kind: string;
  previewText: string;
  quoteText: string | null;
  onOpen: () => void;
}) {
  const preview = previewText.trim() !== '' ? previewText : kind === 'quote' ? 'Quote' : 'Comment';
  const excerpt = quoteText ?? '(whole segment)';
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open this comment thread"
      className="block w-full rounded-lg border border-foreground/15 bg-background/95 px-2.5 py-1.5 text-left shadow-sm hover:border-foreground/30 hover:shadow"
    >
      <div className="flex items-center gap-1 text-[0.7rem] text-foreground/40">
        {kind === 'quote' && (
          <span className="text-amber-700 dark:text-amber-300" aria-hidden>
            ❝
          </span>
        )}
        <span className="truncate italic">
          “{excerpt.length > 48 ? excerpt.slice(0, 48) + '…' : excerpt}”
        </span>
      </div>
      <div className="mt-0.5 truncate text-xs text-foreground/80">
        {preview.length > 64 ? preview.slice(0, 64) + '…' : preview}
      </div>
    </button>
  );
}

/**
 * An inline `contentEditable` cue editor for the CLEANED transcript (R6). Renders
 * as an inline span so the turn's cues flow as continuous text (matching read
 * mode) rather than a stack of boxes. UNCONTROLLED: the initial text is set once
 * as children, the user edits the DOM directly, and we read `textContent` on blur
 * and commit. The caller KEYS this on the persisted text, so an external change
 * (a reverted edit / version reload) remounts it with the new `initialText` —
 * React never re-writes the DOM mid-edit (children prop is constant per mount),
 * so the cursor is never clobbered.
 */
function InlineCueEditor({
  initialText,
  onCommit,
}: {
  initialText: string;
  onCommit: (text: string) => void;
}) {
  return (
    <span
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Edit cleaned transcript segment"
      onBlur={(e) => onCommit(e.currentTarget.textContent ?? '')}
      className="rounded-sm px-0.5 text-foreground/90 outline-none focus:bg-emerald-500/10 focus:ring-1 focus:ring-emerald-500/40"
    >
      {initialText}
    </span>
  );
}

/**
 * Render a segment's text with its highlight char-ranges marked. Splits at every
 * highlight boundary (`splitIntoPieces`) and wraps each covered piece.
 *
 * Kinds & colors:
 *   • code-only span → emerald (clickable → opens its comment card).
 *   • quote span OR any span whose annotation carries comments → yellow (clickable).
 *   • FLAG span (`kind:'flag'`, no real annotation) → the flag's swatch color
 *     (inline style), NON-clickable — this is a live observation tinting the cue
 *     it was logged against (Change R4).
 *   • the PENDING (brushed-but-uncommitted) selection → a transient yellow brush.
 *
 * A piece may carry several ids (overlapping ranges). A real annotation id wins
 * the interaction (clickable); a pure flag/pending piece is non-interactive.
 *
 * Crucially the indicators (comment underline, ring) add NO characters — selection
 * anchoring (`charOffsetWithin`) measures rendered-text length, so injecting a
 * glyph would shift later selections' char offsets and corrupt new anchors.
 */
function renderHighlightedText(
  text: string,
  highlights: Highlight[],
  annById: Map<string, MyAnnotationView>,
  onFocus: (ann: MyAnnotationView, e: React.MouseEvent) => void,
  commentedAnnIds: Set<string>,
  openCommentAnnId: string | null,
  pendingAnnId: string,
): React.ReactNode {
  // Data-driven colors (flags). Built off the passed highlights, so no extra param.
  const colorById = new Map<string, string>();
  for (const h of highlights) if (h.color) colorById.set(h.annotationId, h.color);

  const pieces = splitIntoPieces(text, highlights);
  return pieces.map((piece, idx) => {
    if (piece.highlightIds.length === 0) {
      return <span key={idx}>{piece.text}</span>;
    }
    // Real annotation ids = not pending, not a flag, not a search match (all sentinel
    // prefixes). Those three are non-clickable background tints; an annotation wins
    // the click/style when it overlaps one.
    const realIds = piece.highlightIds.filter(
      (hid) =>
        hid !== pendingAnnId &&
        !hid.startsWith('flag:') &&
        !hid.startsWith('search:'),
    );

    if (realIds.length === 0) {
      // Search match → orange (the current match brighter). Checked before flags so
      // the active search hit is always visible. Background only (no padding/glyph) so
      // it never shifts text.
      if (piece.kinds.includes('search-current')) {
        return (
          <mark key={idx} className="rounded-sm bg-orange-400/80 text-foreground" title="Current match">
            {piece.text}
          </mark>
        );
      }
      if (piece.kinds.includes('search')) {
        return (
          <mark key={idx} className="rounded-sm bg-orange-300/55 text-foreground" title="Search match">
            {piece.text}
          </mark>
        );
      }
      // Pure flag piece → swatch-colored, non-clickable tint. Background only (no
      // padding) so the tint never changes the cue's width or shifts later text.
      const flagId = piece.highlightIds.find((hid) => hid.startsWith('flag:'));
      if (flagId && colorById.has(flagId)) {
        return (
          <mark
            key={idx}
            style={{ backgroundColor: hexWithAlpha(colorById.get(flagId)!, 0.32) }}
            className="rounded-sm text-foreground"
            title="A live flag was logged at this moment"
          >
            {piece.text}
          </mark>
        );
      }
      // No real annotation and no flag color → nothing to paint (the in-progress
      // selection is shown by the native browser selection, not a synthetic brush).
      return <span key={idx}>{piece.text}</span>;
    }

    const hasQuote = piece.kinds.includes('quote');
    const firstId = realIds[0];
    const ann = annById.get(firstId);
    const hasComment = realIds.some((hid) => commentedAnnIds.has(hid));
    const isOpen = openCommentAnnId !== null && realIds.includes(openCommentAnnId);
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
          if (ann) onFocus(ann, e);
        }}
        title={title}
        className={`cursor-pointer rounded-sm ${
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

/**
 * Turn a CSS color into a translucent fill for a flag tint. Hex (`#rgb`/`#rrggbb`)
 * is converted to `rgba(...)`; any other CSS color (named, `var(--…)`) is returned
 * unchanged (it can't be alpha-composited here, but flag swatches are hex in
 * practice). Used only for the data-driven FLAG highlight color.
 */
function hexWithAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

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
  addCodeToAnnotation,
  removeCodeFromAnnotation,
  updateAnnotationAnchor,
  deleteAnnotation,
  listMyAnnotationsForVersion,
  addAnnotationComment,
  listAnnotationComments,
  editAnnotationComment,
  deleteAnnotationComment,
  type MyAnnotationView,
  type AnnotationCommentView,
} from '@/app/actions/annotations';
import { type SessionEpisodeView } from '@/app/actions/episodes';
import type { ObservationView } from '@/app/actions/observations';
import type { ChatMessage } from '@/app/actions/chat';
import { alignChat, activeChatIndex } from '@/lib/chat/align';
import type { SpecTimelineResult } from '@/app/actions/spec';
import { specStateAt } from '@/lib/spec/reconstruct';
import { retroQuestionsAt } from '@/lib/live/retro';
import CodingPopup, { type PopupCode } from './CodingPopup';
import ChatReplayPane from './ChatReplayPane';
import SpecReplay from './SpecReplay';
import {
  buildMultiAnchor,
  splitIntoPieces,
  type Highlight,
} from '@/lib/transcript/selection';
import { groupIntoTurns } from '@/lib/transcript/turns';
import { findActiveIndex } from '@/lib/transcript/active';
import { findPhraseMatches } from '@/lib/transcript/search';
import { cardsByTurn, type RailCard } from '@/lib/transcript/rail';
import { packGutter, sameAnchor, type GutterInput } from '@/lib/transcript/gutter';
import { useRealtimeAnnotations } from './useRealtimeAnnotations';

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
  retroQuestionScenarioIdx?: number | null;
}): boolean {
  // A RETRO-QUESTION row (retro_question_scenario_idx non-null) is its OWN kind —
  // its `body` is the researcher's queued question, not a flag/note. It is surfaced
  // in the Specification panel (retroQuestionsAt), NOT on the flags surfaces, so
  // exclude it here even though it carries a non-empty body.
  if (typeof o.retroQuestionScenarioIdx === 'number') return false;
  return !!o.flagLabel || !!(o.body && o.body.trim()) || o.isQuote;
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
 *  Coding happens in the selection-spawned popup (CodingPopup); codes render as
 *  brace-grouped chip blocks in the right gutter, comments as margin cards.
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
  specTimeline = { specEdits: [], entityEdits: [] },
  recordingStartedAt = null,
  codebookId,
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
  codes?: PopupCode[];
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
  /** The participant's evolving spec/entities edit streams (spec-mode, Task SV1).
   *  Reconstructed + projected onto the SAME `anchorMs`/playhead clock client-side
   *  (specStateAt) so the Specification tab replays the spec as the video scrubs. */
  specTimeline?: SpecTimelineResult;
  /** The EFFECTIVE recording anchor (ISO) — t=0 for turning an observation's
   *  absolute `createdAt` into a video offset. Null only when even the task start
   *  can't be derived (the flag surfaces then render nothing, silently). */
  recordingStartedAt?: string | null;
  /** The resolved codebook id new codes are authored into (the popup's New code). */
  codebookId: string;
  /** This session's `cb_sessions.collection` — the per-code authoring study. */
  collection: string | null;
  /** Link to the post-hoc, read-only Compare tab. */
  compareHref?: string | null;
}) {
  const router = useRouter();

  // --- Modes: COMMENT (default) vs CODE -----------------------------------
  // Two selection grammars share one transcript. COMMENT mode: select → start
  // typing → a marginalia composer captures the keystrokes; ⏎/⌘⏎ saves (a bare
  // highlight with no comment cannot be saved — a highlight that says nothing IS
  // nothing). CODE mode: select → the coding popup spawns at the release point.
  // Defaulting to Comment makes the cheap, frequent act (reacting to the data)
  // zero-friction and the schema-bearing act (coding) deliberate.
  const [mode, setMode] = useState<'comment' | 'code'>('comment');
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  const [assignedAnnId, setAssignedAnnId] = useState<string | null>(null);
  // "Edit selection" on a bracket: the NEXT selection re-anchors this annotation
  // instead of opening the popup / composer.
  const [reanchoringId, setReanchoringId] = useState<string | null>(null);

  // --- Transcript layers (feature #20): original (verbatim) vs cleaned --------
  const cleanedVersionFromList = versions.find((v) => v.kind === 'cleaned') ?? null;
  // Three transcript-pane modes: the two transcript versions (original/cleaned),
  // plus the segment-LESS "specification" replay (spec-mode). The first two load
  // segments via the version mechanism; 'specification' reconstructs from
  // `specTimeline` independently and never touches `versionId`/`segments`.
  const [activeTab, setActiveTab] = useState<
    'original' | 'cleaned' | 'specification'
  >('original');
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

  // Switch to the segment-LESS "Specification" replay. Unlike the transcript
  // tabs, this does NOT load a version: the spec view reconstructs from
  // `specTimeline` independently (specState memo), so `versionId`/`segments` stay
  // EXACTLY as they were — switching back to a transcript tab restores the same
  // loaded text without a refetch. We DO clear the transcript-bound interaction
  // state (text selection, composer, open comment, edit mode) so none of it
  // bleeds into the read-only spec surface.
  const handleSelectSpecification = useCallback(() => {
    if (activeTab === 'specification') return;
    setActiveTab('specification');
    setEditing(false);
    setTextSel(null);
    setComposerOpen(false);
    setActiveIdx(-1);
    setOpenCommentAnnId(null);
  }, [activeTab]);

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
      setPopupPos(null);
      setAssignedAnnId(null);
      return;
    }
    // Build the (possibly multi-cue) anchor from the covered cues' texts.
    const segTexts: string[] = [];
    for (let i = r.startSegIdx; i <= r.endSegIdx; i++) segTexts.push(segments[i].text);
    const anchor = buildMultiAnchor(segTexts, r.startChar, r.endChar);
    if (!anchor) {
      setTextSel(null);
      setPopupPos(null);
      setAssignedAnnId(null);
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

    const startSeg = segments[r.startSegIdx];
    const endSeg = segments[r.endSegIdx];

    // RE-ANCHOR gesture: this selection replaces an existing bracket's span —
    // codes and comments ride along; no popup, no composer.
    if (reanchoringId) {
      const target = reanchoringId;
      setReanchoringId(null);
      void (async () => {
        try {
          await updateAnnotationAnchor(target, {
            segmentId: startSeg.id,
            endSegmentId: r.endSegIdx !== r.startSegIdx ? endSeg.id : null,
            charStart: anchor.startChar,
            charEnd: anchor.endChar,
            quoteText: anchor.quoteText,
            prefix: anchor.prefix,
            suffix: anchor.suffix,
            tStartMs: startSeg.startMs,
            tEndMs: endSeg.endMs,
          });
          await refreshActiveAnnotations();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to re-anchor.');
        } finally {
          setTextSel(null);
          window.getSelection()?.removeAllRanges();
        }
      })();
      return;
    }

    if (mode === 'code') {
      // Spawn the coding popup at the release point. If one of MY code annotations
      // already sits on this IDENTICAL anchor, its codes prefill the popup's chips —
      // re-selecting the same span means "edit that group", not "start a duplicate".
      const existing = myAnnotations.find(
        (a) =>
          a.kind === 'code' &&
          sameAnchor(
            {
              segmentId: a.segmentId,
              endSegmentId: a.endSegmentId,
              charStart: a.charStart,
              charEnd: a.charEnd,
            },
            {
              segmentId: startSeg.id,
              endSegmentId: r.endSegIdx !== r.startSegIdx ? endSeg.id : null,
              charStart: anchor.startChar,
              charEnd: anchor.endChar,
            },
          ),
      );
      setAssignedAnnId(existing?.id ?? null);
      setPopupPos({ x: e.clientX, y: e.clientY });
    }
    // COMMENT mode: the selection just sits (painted pending); typing opens the
    // marginalia composer via the keyboard handler below.
  }, [segments, myAnnotations, mode, reanchoringId, refreshActiveAnnotations]);

  const clearSelection = useCallback(() => {
    setTextSel(null);
    setComposerOpen(false);
    setPopupPos(null);
    setAssignedAnnId(null);
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

  // segment id → its index in `segments` (transcript order). Used to expand a
  // multi-cue annotation's start/end segment ids back into a covered index range.
  const segIndexById = useMemo(() => {
    const m = new Map<string, number>();
    segments.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [segments]);

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

  // Assign a code to the CURRENT SELECTION (the popup's one job). First assign
  // creates the annotation (kind:'code', multi-cue anchor) and remembers its id;
  // every further assign ADDS to that same annotation — multiple codes, one anchor,
  // which is what lets the gutter render them as one brace-grouped block. The
  // selection is deliberately NOT cleared on assign: the popup stays open so more
  // codes can join, and closes only on Done/Esc/outside click.
  const handleAssignCode = useCallback(
    async (codeId: string) => {
      if (!versionId || !codeId || !pending) return;
      setApplying(true);
      setError(null);
      try {
        // A stale assignedAnnId (its last code was removed and the anchor deleted
        // server-side) must not receive junction rows — verify it still exists.
        const live =
          assignedAnnId !== null &&
          myAnnotations.some((a) => a.id === assignedAnnId && a.kind === 'code')
            ? assignedAnnId
            : null;
        let added = false;
        if (live !== null) {
          // The id can still be stale (deleted server-side after our snapshot): the
          // action probes and reports 'annotation_gone' instead of erroring, and we
          // fall through to creating a fresh anchor rather than failing the assign.
          added = (await addCodeToAnnotation(live, codeId)) === 'added';
        }
        if (!added) {
          const ann = await addAnnotation({
            sessionId: id,
            versionId,
            segmentId: pending.startSeg.id,
            endSegmentId:
              pending.endSeg.id !== pending.startSeg.id ? pending.endSeg.id : undefined,
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
          setAssignedAnnId(ann.id);
        }
        await afterAnnotationMutation();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to assign the code.');
      } finally {
        setApplying(false);
      }
    },
    [versionId, pending, id, assignedAnnId, myAnnotations, afterAnnotationMutation],
  );

  // Remove one code from a BRACKET (gutter ×). The bracket survives — even empty —
  // because the anchor records "this span matters" independently of which codes
  // currently name it; deleting the bracket is its own explicit act.
  const handleRemoveCodeFromBracket = useCallback(
    async (annId: string, codeId: string) => {
      setError(null);
      try {
        await removeCodeFromAnnotation(annId, codeId);
        await afterAnnotationMutation();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to remove the code.');
      }
    },
    [afterAnnotationMutation],
  );

  // Reopen the coding popup ON an existing bracket (gutter block click): its span
  // becomes the pending selection (painted), its id receives further assigns.
  const openPopupForAnnotation = useCallback(
    (ann: MyAnnotationView, e: React.MouseEvent) => {
      const startIdx = segIndexById.get(ann.segmentId);
      if (startIdx === undefined) return;
      const endIdx = ann.endSegmentId
        ? segIndexById.get(ann.endSegmentId) ?? startIdx
        : startIdx;
      setTextSel({
        startSegIdx: startIdx,
        endSegIdx: endIdx,
        startChar: ann.charStart,
        endChar: ann.charEnd,
        quoteText: ann.quoteText ?? '',
        prefix: '',
        suffix: '',
      });
      setAssignedAnnId(ann.id);
      setPopupPos({ x: e.clientX, y: e.clientY });
    },
    [segIndexById],
  );

  // Remove ONE code from the selection's annotation. The action's last-code policy
  // applies server-side (comments → demote to quote; none → delete the anchor); the
  // refetch reflects whichever happened, and a vanished anchor simply leaves the
  // chips empty — the next assign starts a fresh annotation.
  const handleUnassignCode = useCallback(
    async (codeId: string) => {
      if (!assignedAnnId) return;
      setApplying(true);
      setError(null);
      try {
        await removeCodeFromAnnotation(assignedAnnId, codeId);
        await afterAnnotationMutation();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to remove the code.');
      } finally {
        setApplying(false);
      }
    },
    [assignedAnnId, afterAnnotationMutation],
  );

  // --- Per-excerpt comments (margin) --------------------------------------

  const openCommentThread = useCallback(
    async (annotationId: string) => {
      setComposerOpen(false);
      setOpenCommentAnnId(annotationId);
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

  // Add a note from the inline "Add a note…" editor (uncontrolled — the text is
  // read from the DOM at commit, never round-tripped through React state, so the
  // caret is never clobbered mid-edit). Mirrors handleAddComment but takes the
  // committed text directly instead of reading the (now removed) commentDraft.
  const handleAddNote = useCallback(
    async (text: string) => {
      if (!openCommentAnnId || text.trim() === '') return;
      setCommentBusy(true);
      setCommentError(null);
      try {
        await addAnnotationComment(openCommentAnnId, text.trim());
        const grouped = await listAnnotationComments([openCommentAnnId]);
        setComments((prev) => ({
          ...prev,
          [openCommentAnnId]: grouped[openCommentAnnId] ?? [],
        }));
        await afterAnnotationMutation();
      } catch (e) {
        setCommentError(e instanceof Error ? e.message : 'Failed to add note.');
      } finally {
        setCommentBusy(false);
      }
    },
    [openCommentAnnId, afterAnnotationMutation],
  );

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
      // The composer textarea is UNCONTROLLED (no value prop) to keep the caret
      // stable while typing; clear its DOM value imperatively on submit.
      if (composerTextareaRef.current) composerTextareaRef.current.value = '';
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

  // Edit a note's body in place (inline-edit commit). An empty commit DELETES the
  // note (Docs-like) rather than persisting a blank. A no-op edit (unchanged body)
  // short-circuits so we don't spend a round-trip on every blur.
  const handleEditComment = useCallback(
    async (commentId: string, nextBody: string, prevBody: string) => {
      if (!openCommentAnnId) return;
      const trimmed = nextBody.trim();
      if (trimmed === prevBody.trim()) return; // unchanged → nothing to do
      setCommentRowBusyId(commentId);
      setCommentError(null);
      try {
        if (trimmed === '') {
          await deleteAnnotationComment(commentId);
        } else {
          await editAnnotationComment(commentId, trimmed);
        }
        const grouped = await listAnnotationComments([openCommentAnnId]);
        setComments((prev) => ({
          ...prev,
          [openCommentAnnId]: grouped[openCommentAnnId] ?? [],
        }));
        await afterAnnotationMutation();
      } catch (e) {
        setCommentError(e instanceof Error ? e.message : 'Failed to edit comment.');
      } finally {
        setCommentRowBusyId(null);
      }
    },
    [openCommentAnnId, afterAnnotationMutation],
  );

  // Clicking a highlighted span (or a code-chip block) opens its comment thread in
  // the margin rail
  // popover anchored at the click point.
  const openThreadForAnnotation = useCallback(
    (ann: MyAnnotationView) => {
      void openCommentThread(ann.id);
    },
    [openCommentThread],
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
        setReanchoringId(null); // an armed re-anchor dies with Esc, like everything
        clearSelection(); // also closes the coding popup (popupPos lives in it)
        return;
      }
      if (!codingEnabled) return;

      // COMMENT mode, marginalia-style: with a selection pending, just START TYPING
      // and the margin composer opens seeded with that first keystroke (the
      // annotator-HTML gesture). ⌘⏎ (or ⏎ later, in the composer) saves. No
      // modifier chords to memorize — the selection is the mode.
      if (mode === 'comment' && pending && !composerOpen && !popupPos) {
        const target = e.target as HTMLElement | null;
        const inField =
          target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
        if (!inField) {
          const printable =
            e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
          const commitChord = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
          if (printable || commitChord) {
            e.preventDefault();
            setOpenCommentAnnId(null);
            if (printable) setSelectionCommentDraft((d) => d + e.key);
            setComposerOpen(true);
            setTimeout(() => composerTextareaRef.current?.focus(), 0);
          }
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [codingEnabled, pending, composerOpen, popupPos, mode, clearSelection]);

  // --- Derived view helpers ----------------------------------------------

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
      // kind:'code' NEVER paints inline (owner's call, overriding an earlier review
      // fix): the bracket + chip block in the gutter is the code's ONLY rendering.
      // A background wash on coded text made every coded span read like a comment
      // highlight — two different speech acts in one visual voice.
      if (a.kind === 'code') continue;
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

  // --- Spec replay reconstruction (spec-mode) -----------------------------
  // ONE CLOCK: the spec replay projects onto the SAME `anchorMs` (the flags'
  // anchor) + the SAME `currentMs` playhead the chat/transcript use — it does NOT
  // re-parse `recordingStartedAt` or keep its own tick. `specStateAt` takes an
  // ABSOLUTE epoch instant = `anchorMs + currentMs`. When `anchorMs` is null the
  // spec CANNOT be placed on the timeline — `(null ?? 0) + currentMs` is a tiny
  // epoch that precedes every edit, so specState resolves to the empty
  // pre-first-edit state for the WHOLE video. We still compute it, but the pane
  // gates the DISPLAY on `anchorResolved` (below) and shows a hint instead of a
  // misleading empty spec — mirroring the chat pane. Recomputes per tick.
  const specState = useMemo(
    () => specStateAt(specTimeline, (anchorMs ?? 0) + currentMs),
    [specTimeline, anchorMs, currentMs],
  );
  // Whether the participant recorded ANY spec/entity edits (distinct from "have
  // edits but no anchor to place them"). Drives SpecReplay's two empty states.
  const hasSpecData =
    specTimeline.specEdits.length > 0 || specTimeline.entityEdits.length > 0;

  // --- Dynamic retrospective questions (spec-mode display) ----------------
  // The custom retrospective questions the researcher QUEUED on /live, surfaced in
  // SPECIFICATION mode. ONE CLOCK: same `anchorMs` (the flags' anchor) + same
  // `currentMs` playhead the spec/chat use — a question appears exactly when the
  // playhead reaches the instant it was asked. Each is a `cb_observations` row whose
  // `retroQuestionScenarioIdx` is non-null (its `body` is the question text).
  const retroQuestions = useMemo(
    () => retroQuestionsAt(observations, anchorMs, currentMs),
    [observations, anchorMs, currentMs],
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
  // Merge committed annotation highlights + flag highlights + the PENDING selection.
  // The pending range IS painted synthetically now (kind:'pending'): the coding popup
  // steals focus the moment it opens, which kills the native browser selection — and a
  // selection the coder can no longer SEE while choosing a code breaks the whole
  // "stays highlighted while I pick" contract.
  const PENDING_ANN_ID = '__pending__';
  const highlightsBySegmentAll = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    const segIds = new Set<string>([...highlightsBySegment.keys()]);
    // FLAG tints deliberately NOT merged: whole-cue washes reveal the cue
    // segmentation and chop the paragraph into colored blocks — the transcript
    // should read continuously, like an essay. Flags stay on the timeline bar and
    // the flag list, which is where a time-anchored event belongs.
    for (const segId of segIds) {
      m.set(segId, [...(highlightsBySegment.get(segId) ?? [])]);
    }
    if (textSel) {
      for (let i = textSel.startSegIdx; i <= textSel.endSegIdx; i++) {
        const seg = segments[i];
        if (!seg) continue;
        const list = m.get(seg.id) ?? [];
        list.push({
          annotationId: PENDING_ANN_ID,
          charStart: i === textSel.startSegIdx ? textSel.startChar : 0,
          charEnd: i === textSel.endSegIdx ? textSel.endChar : seg.text.length,
          kind: 'pending',
        });
        m.set(seg.id, list);
      }
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
  }, [highlightsBySegment, searchMatches, safeMatchIdx, segments, textSel]);

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

  // --- Code-brace gutter (measured imperatively, no setState-in-effect) ----
  // kind:'code' annotations render as BRACE-GROUPED blocks in the gutter: a bracket
  // spanning the coded text's vertical extent + a chip block listing the codes.
  // Bucketed by the ANCHOR turn (the turn holding the start cue); an annotation
  // that runs past its turn is clamped to the turn's last cue and flagged
  // `continues` (the brace draws an open end rather than lying about the span).
  const turnIndexBySegIdxForCodes = useMemo(() => {
    const m = new Map<number, number>();
    turns.forEach((t, ti) => t.segIndices.forEach((si) => m.set(si, ti)));
    return m;
  }, [turns]);

  const codeBlocksByTurn = useMemo(() => {
    const m = new Map<
      number,
      { ann: MyAnnotationView; startIdx: number; endIdx: number; continues: boolean }[]
    >();
    for (const a of myAnnotations) {
      if (a.kind !== 'code') continue;
      const startIdx = segIndexById.get(a.segmentId);
      if (startIdx === undefined) continue;
      const rawEnd = a.endSegmentId ? segIndexById.get(a.endSegmentId) ?? startIdx : startIdx;
      const turnIdx = turnIndexBySegIdxForCodes.get(startIdx);
      if (turnIdx === undefined) continue;
      const turnLast = turns[turnIdx]?.segIndices[turns[turnIdx].segIndices.length - 1] ?? startIdx;
      const endIdx = Math.min(Math.max(rawEnd, startIdx), turnLast);
      const list = m.get(turnIdx) ?? [];
      list.push({ ann: a, startIdx, endIdx, continues: rawEnd > turnLast });
      m.set(turnIdx, list);
    }
    // Deterministic block order inside a turn: text order, id tiebreak.
    for (const list of m.values()) {
      list.sort((x, y) =>
        x.startIdx !== y.startIdx ? x.startIdx - y.startIdx : x.ann.id.localeCompare(y.ann.id),
      );
    }
    return m;
  }, [myAnnotations, segIndexById, turns, turnIndexBySegIdxForCodes]);

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

  const railEnabled = !editing && codingEnabled;
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
        ? cardsByTurn(
            myAnnotations,
            // The OPEN annotation always earns a card: a bare kind:'code' anchor has
            // no persistent card (no comments, not a quote), so clicking its gutter
            // chip block would otherwise be a visible no-op — the tooltip promises a
            // thread and nothing mounts. Unioning the open id makes the CommentCard
            // appear for exactly as long as the thread is open; it persists only if
            // a comment is actually posted (commentedAnnIds then retains it).
            openCommentAnnId
              ? new Set([...commentedAnnIds, openCommentAnnId])
              : commentedAnnIds,
            segIndexById,
            turnIndexBySegIdx,
          )
        : new Map<number, RailCard[]>(),
    [railEnabled, myAnnotations, commentedAnnIds, segIndexById, turnIndexBySegIdx, openCommentAnnId],
  );

  // Close any open card / composer and clear the selection. Shared by every card's
  // close button.
  const closeCard = useCallback(() => {
    setComposerOpen(false);
    setOpenCommentAnnId(null);
    setCommentError(null);
    setSelectionCommentDraft('');
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
      const codeBlocks = codeBlocksByTurn.get(turnIdx) ?? [];
      const showComposerHere = composerOpenForRail && composerAnchorTurnIdx === turnIdx;
      if (cards.length === 0 && !showComposerHere && codeBlocks.length === 0) return null;

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
            data-rail-card
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
                selectionCommentDraft={selectionCommentDraft}
                commentBusy={commentBusy}
                commentRowBusyId={commentRowBusyId}
                canCommentOnSelection={canCommentOnSelection}
                composerTextareaRef={composerTextareaRef}
                busyId={busyId}
                formatTime={formatTime}
                onClose={closeCard}
                onSeek={seekTo}
                onChangeSelectionDraft={setSelectionCommentDraft}
                onCommentOnSelection={handleCommentOnSelection}
                onAddNote={handleAddNote}
                onEditComment={handleEditComment}
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
          <div key="__composer__" data-rail-card className="absolute left-0 top-0 w-60" style={{ zIndex: 50 }}>
            <CommentCard
              composerMode
              pendingQuote={pending?.quoteText ?? null}
              openCommentAnn={null}
              openThread={[]}
              commentError={commentError}
              selectionCommentDraft={selectionCommentDraft}
              commentBusy={commentBusy}
              commentRowBusyId={commentRowBusyId}
              canCommentOnSelection={canCommentOnSelection}
              composerTextareaRef={composerTextareaRef}
              busyId={busyId}
              formatTime={formatTime}
              onClose={closeCard}
              onSeek={seekTo}
              onChangeSelectionDraft={setSelectionCommentDraft}
              onCommentOnSelection={handleCommentOnSelection}
              onAddNote={handleAddNote}
              onEditComment={handleEditComment}
              onDeleteComment={handleDeleteComment}
              onDeleteAnnotation={handleDeleteAnnotation}
            />
          </div>,
        );
      }

      // CODE blocks: a brace spanning the coded text + a chip block beside it. Both
      // render position-less (opacity-0) and are laid out IMPERATIVELY by the
      // measurement effect below — writing styles through the DOM, never setState,
      // so the repo's no-setState-in-effect rule holds and there is no re-render
      // loop. data-* attributes carry the anchor indices the effect needs.
      codeBlocks.forEach((b) => {
        nodes.push(
          <div
            key={`brace:${b.ann.id}`}
            data-code-brace
            data-ann-id={b.ann.id}
            data-start-idx={b.startIdx}
            data-end-idx={b.endIdx}
            aria-hidden
            // Spine on the RIGHT (away from the text), serifs curling LEFT toward
            // the span it groups — a closing `⟩` hugging the text's edge. (The first
            // cut had the spine text-side, which read as a rule between text and
            // gutter rather than a grouping bracket.)
            className={`pointer-events-none absolute w-2 rounded-r border-r-2 border-t-2 border-emerald-600/70 opacity-0 ${
              b.continues ? '' : 'border-b-2'
            }`}
            style={{ left: -14 }}
          />,
        );
        nodes.push(
          <div
            key={`chips:${b.ann.id}`}
            data-code-block
            data-ann-id={b.ann.id}
            data-start-idx={b.startIdx}
            className="absolute left-0 w-56 opacity-0"
            style={{ zIndex: 5 }}
          >
            {/* The block manages CODES — it is not a comment affordance. Click →
                reopen the coding popup on this bracket (add more codes); × on a chip
                removes THAT code (the bracket survives, even empty); ✎ re-anchors
                (next selection replaces the span); 🗑 deletes the bracket itself. */}
            <div className="flex flex-wrap items-center gap-1 border border-foreground/10 bg-background/95 p-1">
              <button
                type="button"
                onClick={(e) => openPopupForAnnotation(b.ann, e)}
                title="Add codes to this bracket"
                className="flex min-w-0 flex-wrap items-center gap-1 text-left"
              >
                {b.ann.codes.length === 0 ? (
                  <span className="px-1 text-[11px] italic text-foreground/40">no codes</span>
                ) : null}
                {b.ann.codes.map((c) => (
                  <span
                    key={c.id}
                    className="inline-flex items-center gap-0.5 border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {c.mnemonic}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemoveCodeFromBracket(b.ann.id, c.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.stopPropagation();
                          void handleRemoveCodeFromBracket(b.ann.id, c.id);
                        }
                      }}
                      title={`Remove ${c.mnemonic} (the bracket stays)`}
                      className="cursor-pointer px-0.5 text-foreground/40 hover:text-red-600"
                    >
                      ×
                    </span>
                  </span>
                ))}
              </button>
              <span className="ml-auto flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setReanchoringId(b.ann.id);
                  }}
                  title="Edit selection — the next text you highlight becomes this bracket's span"
                  className="px-0.5 text-[11px] text-foreground/40 hover:text-foreground"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Delete this bracket (its codes and comments go with it)?')) {
                      void handleDeleteAnnotation(b.ann.id);
                    }
                  }}
                  title="Delete the bracket"
                  className="px-0.5 text-[11px] text-foreground/40 hover:text-red-600"
                >
                  🗑
                </button>
              </span>
            </div>
          </div>,
        );
      });

      return <>{nodes}</>;
    },
    [
      railEnabled,
      railCardsByTurn,
      codeBlocksByTurn,
      openPopupForAnnotation,
      handleRemoveCodeFromBracket,
      composerOpenForRail,
      composerAnchorTurnIdx,
      annById,
      openCommentAnnId,
      comments,
      commentError,
      selectionCommentDraft,
      commentBusy,
      commentRowBusyId,
      canCommentOnSelection,
      busyId,
      pending,
      closeCard,
      seekTo,
      handleCommentOnSelection,
      handleAddNote,
      handleEditComment,
      handleDeleteComment,
      handleDeleteAnnotation,
      openThreadForAnnotation,
    ],
  );

  // The post-create auto-assign resolves through a REF so it always sees the LATEST
  // handler closure: createCode's round-trip is slow, and if the coder hits Esc in
  // that window the captured closure would still hold the old `pending` and code a
  // selection that was already canceled. The ref re-checks live state at fire time.
  const handleAssignCodeRef = useRef(handleAssignCode);
  useEffect(() => {
    handleAssignCodeRef.current = handleAssignCode;
  }, [handleAssignCode]);

  // The popup's chips: the codes already on the selection's annotation, resolved to
  // full PopupCode shapes (metadata expansion needs origin/definition). A stale id
  // (annotation deleted server-side by last-code removal) resolves to null → empty.
  const popupCodeById = useMemo(() => new Map(codes.map((c) => [c.id, c])), [codes]);
  const assignedAnn = assignedAnnId
    ? myAnnotations.find((a) => a.id === assignedAnnId) ?? null
    : null;
  const assignedPopupCodes = useMemo(
    () =>
      (assignedAnn?.codes ?? []).map(
        (c) =>
          popupCodeById.get(c.id) ?? {
            id: c.id,
            mnemonic: c.mnemonic,
            name: c.mnemonic,
            origin: 'emergent',
            definition: null,
          },
      ),
    [assignedAnn, popupCodeById],
  );

  // Lay the brace gutter out IMPERATIVELY: measure cue spans, pack chip blocks,
  // write styles straight to the DOM. No setState — measurement-driven state would
  // either loop (render → measure → setState → render) or trip the repo's
  // no-setState-in-effect rule; writing through refs does neither. Re-runs on data
  // changes and window resize; elements start opacity-0 and are revealed once
  // positioned so there is no flash of unpositioned chrome.
  useEffect(() => {
    const root = transcriptRef.current;
    if (!root) return;

    const layout = () => {
      const cells = root.querySelectorAll<HTMLElement>('[data-comment-card]');
      cells.forEach((cell) => {
        const braces = cell.querySelectorAll<HTMLElement>('[data-code-brace]');
        const blocks = cell.querySelectorAll<HTMLElement>('[data-code-block]');
        if (braces.length === 0 && blocks.length === 0) return;
        if (cell.offsetParent === null) return; // hidden (mobile) — nothing to place
        const cellRect = cell.getBoundingClientRect();

        // Comment cards already occupy the top of this cell; blocks pack BELOW the
        // deepest one. Represent that occupancy as a synthetic first gutter block.
        let cardsBottom = 0;
        cell.querySelectorAll<HTMLElement>('[data-rail-card]').forEach((card) => {
          const r = card.getBoundingClientRect();
          cardsBottom = Math.max(cardsBottom, r.bottom - cellRect.top);
        });

        // Braces: pinned to the coded text's true extent — they NEVER pack.
        const extents = new Map<string, { top: number; bottom: number }>();
        braces.forEach((el) => {
          const startIdx = Number(el.dataset.startIdx);
          const endIdx = Number(el.dataset.endIdx);
          const startEl = rowRefs.current[startIdx];
          const endEl = rowRefs.current[endIdx] ?? startEl;
          if (!startEl || !endEl) return;
          const top = startEl.getBoundingClientRect().top - cellRect.top;
          const bottom = endEl.getBoundingClientRect().bottom - cellRect.top;
          extents.set(el.dataset.annId ?? '', { top, bottom });
          el.style.top = `${top}px`;
          el.style.height = `${Math.max(bottom - top, 8)}px`;
          el.style.opacity = '1';
        });

        // Chip blocks: desired at their brace top, packed downward (never up) so
        // stacked/overlapping ranges stay readable. Pure policy in packGutter.
        const inputs: GutterInput[] = [];
        if (cardsBottom > 0) {
          inputs.push({ id: '__cards__', top: 0, bottom: 0, blockHeight: cardsBottom });
        }
        blocks.forEach((el) => {
          const ext = extents.get(el.dataset.annId ?? '');
          inputs.push({
            id: el.dataset.annId ?? '',
            top: ext?.top ?? 0,
            bottom: ext?.bottom ?? 0,
            blockHeight: el.offsetHeight || 24,
          });
        });
        const packed = new Map(packGutter(inputs, 6).map((b) => [b.id, b]));
        blocks.forEach((el) => {
          const b = packed.get(el.dataset.annId ?? '');
          if (!b) return;
          el.style.top = `${b.blockTop}px`;
          el.style.opacity = '1';
        });
      });
    };

    // After paint (fonts/wraps settled), then again on any resize.
    const raf = requestAnimationFrame(layout);
    window.addEventListener('resize', layout);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', layout);
    };
  }, [
    codeBlocksByTurn,
    segments,
    turns,
    comments,
    openCommentAnnId,
    composerOpen,
    activeTab,
    editing,
    railEnabled,
    searchMatches,
  ]);

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
  // The spec-replay pane, hoisted so BOTH the review and coding branches render
  // an identical surface (they only differ in the transcript's gutter). Its
  // CONTENT is time-derived (specState = specStateAt(anchorMs + currentMs)) — but
  // HYDRATION-SAFE WITHOUT a mount gate: at the first render `currentMs === 0` on
  // both the server and the client and `anchorMs` is deterministic from props, so
  // `specState` is identical across server/first-client render (exactly the
  // property the un-gated chatPane below relies on — one shared clock, same
  // cadence). No `mounted` flag is needed (and the repo bans set-state-in-effect,
  // so adding one would introduce a lint error). Placed in the SAME scroll
  // container as the transcript, so the chat 50/50 split (transcriptHeightClass)
  // applies unchanged whether the user is viewing the transcript or the spec.
  const specPane = (
    <>
      {/* Dynamic retrospective questions asked BY the playhead (spec-mode), beside
          the reconstructed spec — so the analyst sees, in scenario/time context,
          the custom question the researcher queued for the participant. Each row is
          a retro-question `cb_observations` row (retroQuestionScenarioIdx non-null);
          its `body` is the question text. Hidden until at least one is reached. */}
      {retroQuestions.length > 0 && (
        <section className="flex flex-col gap-2 pl-3 pb-3">
          <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
            Retrospective questions
          </h3>
          <ul className="flex flex-col gap-1.5">
            {retroQuestions.map((q) => (
              <li
                key={q.id}
                className="border border-[var(--rule)] bg-[var(--rule-soft)] p-2 text-sm"
              >
                <button
                  type="button"
                  onClick={() => seekTo(q.offsetMs)}
                  className="mb-1 font-mono text-[11px] text-[var(--muted)] hover:underline"
                  title="Seek to when this question was asked"
                >
                  {formatTime(q.offsetMs)} · scenario {q.scenarioIdx + 1}
                </button>
                <p className="break-words">
                  <span className="text-[var(--muted)]">
                    Retrospective question asked:{' '}
                  </span>
                  {q.body}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <SpecReplay
        spec={specState.spec}
        entities={specState.entities}
        hasSpecData={hasSpecData}
        anchorResolved={anchorMs != null}
      />
    </>
  );
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
                aria-label="Selection mode"
                className="flex rounded border border-foreground/20 text-xs"
              >
                {(['comment', 'code'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => setMode(m)}
                    className={`px-3 py-1 capitalize first:rounded-l last:rounded-r ${
                      mode === m
                        ? 'bg-foreground text-background'
                        : 'text-foreground/70 hover:text-foreground'
                    }`}
                  >
                    {m}
                  </button>
                ))}
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


        {/* RIGHT: transcript (2/3) with the comment margin + code-brace gutter. */}
        <div className="lg:col-span-2">
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
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'specification'}
              onClick={handleSelectSpecification}
              disabled={versionBusy}
              title="The participant’s evolving specification, replayed in sync with the video"
              className={`rounded px-2 py-1 disabled:opacity-50 ${
                activeTab === 'specification'
                  ? 'bg-foreground text-background'
                  : 'border border-foreground/30 text-foreground/70 hover:text-foreground'
              }`}
            >
              Specification
            </button>
          </div>

          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">
              {activeTab === 'specification' ? 'Specification' : 'Transcript'}
              {activeTab === 'specification' ? (
                <span className="ml-1 font-normal text-foreground/40">· replayed, read-only</span>
              ) : isVerbatim ? (
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
              brighter), steps through with ↑/↓ / Enter, scrolls the match into view.
              Hidden in spec mode — it searches transcript segments, not the spec. */}
          {activeTab !== 'specification' && (
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
          )}

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
          ) : (
            /* REVIEW: flowing transcript with a Google-Docs comment GUTTER. Each
               turn reserves a right gutter; the active card renders in the anchor
               turn's gutter (absolutely placed so it never grows the row), so it
               aligns to its excerpt and scrolls with the content — no measurement. */
            <>
              {codingEnabled && (
                <p className="mb-1 text-xs text-foreground/40">
                  {reanchoringId
                    ? null
                    : mode === 'comment'
                      ? 'Select text → just start typing to leave a margin comment (⏎ saves).'
                      : 'Select text → assign codes in the popup (⌘⏎ assigns · Esc closes).'}
                </p>
              )}
              {reanchoringId && (
                <p className="mb-1 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs text-sky-800 dark:text-sky-200">
                  Re-anchoring: highlight the NEW span for this bracket — its codes and
                  comments ride along. Esc cancels.
                </p>
              )}
              <div
                ref={transcriptRef}
                onMouseUp={
                  codingEnabled && !editing && activeTab !== 'specification'
                    ? handleTranscriptMouseUp
                    : undefined
                }
                style={{ scrollbarGutter: 'stable' }}
                className={`relative overflow-y-auto pr-3 ${transcriptHeightClass}`}
              >
                {activeTab === 'specification' ? (
                  specPane
                ) : (
                  <TranscriptBody
                    {...commonTranscriptProps}
                    renderGutter={renderGutter}
                  />
                )}
              </div>
              {chatPane}
            </>
          )}
        </div>
      </div>

      {/* The coding popup: spawned by a selection, anchored at the release point.
          Assign codes (⌘⏎ / +), read metadata (row click), create a new code (lands
          in the triage queue). It stays open across assigns — multiple codes group
          onto ONE annotation — and closes on Done/Esc/outside click. */}
      {popupPos && pending && (
        <CodingPopup
          pos={popupPos}
          quote={pending.quoteText}
          codes={codes}
          assigned={assignedPopupCodes}
          busy={applying}
          error={error}
          codebookId={codebookId}
          studyLabel={collection ?? 'uncategorized'}
          onAssign={(cid) => void handleAssignCode(cid)}
          onUnassign={(cid) => void handleUnassignCode(cid)}
          onClose={clearSelection}
          onCodeCreated={(cid) => {
            router.refresh();
            void handleAssignCodeRef.current(cid);
          }}
        />
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
  selectionCommentDraft,
  commentBusy,
  commentRowBusyId,
  canCommentOnSelection,
  composerTextareaRef,
  busyId,
  formatTime: fmtTime,
  onClose,
  onSeek,
  onChangeSelectionDraft,
  onCommentOnSelection,
  onAddNote,
  onEditComment,
  onDeleteComment,
  onDeleteAnnotation,
}: {
  composerMode: boolean;
  pendingQuote: string | null;
  openCommentAnn: MyAnnotationView | null;
  openThread: AnnotationCommentView[];
  commentError: string | null;
  selectionCommentDraft: string;
  commentBusy: boolean;
  commentRowBusyId: string | null;
  canCommentOnSelection: boolean;
  composerTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  busyId: string | null;
  formatTime: (ms: number) => string;
  onClose: () => void;
  onSeek: (ms: number) => void;
  onChangeSelectionDraft: (v: string) => void;
  onCommentOnSelection: () => void;
  onAddNote: (text: string) => void;
  onEditComment: (id: string, next: string, prev: string) => void;
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
          {/* UNCONTROLLED (defaultValue, no value prop): the DOM owns the text so
              React never rewrites it mid-edit and the caret is never clobbered.
              onChange still mirrors to state so the Comment button's enablement
              tracks emptiness. Cleared imperatively via composerTextareaRef on
              submit (see handleCommentOnSelection). */}
          <textarea
            ref={composerTextareaRef}
            defaultValue={selectionCommentDraft}
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
            placeholder="Note… (Enter to add · ⇧⏎ newline)"
            rows={2}
            className="mb-2 w-full resize-none rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
            aria-label="Note on selection"
          />
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={onCommentOnSelection}
              disabled={!canCommentOnSelection}
              className="rounded bg-sky-600 px-2.5 py-1 text-xs text-white disabled:opacity-40"
            >
              {commentBusy ? 'Adding…' : 'Add note'}
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

          {/* Notes: each a slim gold-border line, click the text to edit inline
              (uncontrolled → caret-safe), ⌘/Ctrl+Delete to remove. No resolve, no
              timestamps, no thread chrome. Keyed on id+body so a server-side edit
              remounts with fresh text rather than React rewriting the node. */}
          <div className="mb-1 space-y-1">
            {openThread.map((c) => (
              <EditableNote
                key={`${c.id}:${c.body}`}
                author={c.authorName}
                initialText={c.body}
                busy={commentRowBusyId === c.id}
                onCommit={(text) => onEditComment(c.id, text, c.body)}
                onDelete={() => onDeleteComment(c.id)}
              />
            ))}
          </div>

          {/* Add a note — the same inline editor, empty. Enter commits; it remounts
              empty via its key when the reloaded thread grows. */}
          <EditableNote
            key={`add:${openCommentAnn.id}:${openThread.length}`}
            author={null}
            initialText=""
            placeholder="Add a note…"
            busy={commentBusy}
            onCommit={(text) => onAddNote(text)}
            onDelete={() => {}}
          />

          <div className="mt-1.5 flex justify-end">
            <button
              type="button"
              onClick={() => onDeleteAnnotation(openCommentAnn.id)}
              disabled={busyId === openCommentAnn.id}
              className="text-[0.7rem] text-foreground/30 underline hover:text-red-500 disabled:opacity-40"
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
 * A single comment rendered as a slim, inline-editable NOTE: a gold left-border
 * line showing the author and the body. Clicking the body edits it in place;
 * Enter commits, Shift+Enter is a newline, ⌘/Ctrl+Delete (or Backspace) removes it.
 *
 * UNCONTROLLED on purpose — the SAME pattern as `InlineCueEditor`. The initial
 * text is set ONCE as children; the browser owns the DOM text during editing and
 * we read `textContent` on commit. React never rewrites the node mid-edit, so the
 * caret is never clobbered — this is the fix for the reversed-typing ("elloH")
 * bug the old controlled `<textarea value={draft}>` had. The caller KEYS this on
 * `id:body`, so an external change (another coder's edit, a reload) remounts it
 * with fresh text rather than fighting the live edit.
 *
 * Enter both commits AND blurs; `skipBlurRef` stops the ensuing blur from firing
 * a second (duplicate) commit.
 */
function EditableNote({
  author,
  initialText,
  placeholder,
  busy,
  onCommit,
  onDelete,
}: {
  author: string | null;
  initialText: string;
  placeholder?: string;
  busy: boolean;
  onCommit: (text: string) => void;
  onDelete: () => void;
}) {
  const skipBlurRef = useRef(false);
  return (
    <div className={`border-l-2 border-amber-400 pl-2 ${busy ? 'opacity-50' : ''}`}>
      {author && <div className="text-[0.7rem] text-foreground/40">{author}</div>}
      <div
        contentEditable={!busy}
        suppressContentEditableWarning
        role="textbox"
        aria-label={author ? `Edit note by ${author}` : 'Add a note'}
        data-placeholder={placeholder ?? ''}
        onBlur={(e) => {
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
            return;
          }
          onCommit(e.currentTarget.textContent ?? '');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            skipBlurRef.current = true;
            onCommit(e.currentTarget.textContent ?? '');
            e.currentTarget.blur();
          } else if (
            (e.metaKey || e.ctrlKey) &&
            (e.key === 'Backspace' || e.key === 'Delete')
          ) {
            e.preventDefault();
            onDelete();
          }
        }}
        className="min-h-[1.2rem] whitespace-pre-wrap rounded-sm px-0.5 text-sm text-foreground/90 outline-none empty:before:text-foreground/30 empty:before:content-[attr(data-placeholder)] focus:bg-amber-500/5"
      >
        {initialText}
      </div>
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

    // The PENDING selection wins over EVERYTHING it overlaps — search hits, flags,
    // committed annotations. It is the only brush that answers "what am I about to
    // code?", and a selection that visually vanishes wherever it crosses an already-
    // annotated span reads as a broken selection.
    if (piece.kinds.includes('pending')) {
      // Background ONLY — no ring, no rounding: adjacent pieces must fuse into one
      // continuous wash (a ring outlines every internal piece boundary, chopping
      // the selection into visible segments).
      return (
        <mark key={idx} className="bg-sky-300/50 text-foreground dark:bg-sky-400/30" title="Current selection">
          {piece.text}
        </mark>
      );
    }

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
      // No real annotation, no flag color, not pending → nothing to paint.
      return <span key={idx}>{piece.text}</span>;
    }

    const hasQuote = piece.kinds.includes('quote');
    const firstId = realIds[0];
    const ann = annById.get(firstId);
    const hasComment = realIds.some((hid) => commentedAnnIds.has(hid));
    const isOpen = openCommentAnnId !== null && realIds.includes(openCommentAnnId);
    const isYellow = hasQuote || hasComment;
    // Pieces covered ONLY by kind:'code' annotations are the gutter's territory at
    // lg+ (brace + chips), so their inline chrome is suppressed there — painting
    // both would say "highlight" (the comment grammar) about a coded span. Below lg
    // the gutter cell is hidden and this inline mark is the ONLY representation, so
    // it paints fully. The click works at every size (it opens the thread).
    const codeOnly = realIds.every((hid) => (annById.get(hid)?.kind ?? 'code') === 'code');
    const title = hasComment
      ? 'Has comments — click to open the thread'
      : hasQuote
        ? 'Flagged quote — click to comment'
        : 'Coded — click to comment';
    const bg = isYellow
      ? `bg-yellow-300/55 text-foreground dark:bg-yellow-400/30${codeOnly ? ' lg:bg-transparent' : ''}`
      : `bg-emerald-300/50 text-foreground dark:bg-emerald-400/30${codeOnly ? ' lg:bg-transparent' : ''}`;
    const underline = hasComment
      ? `underline decoration-sky-500 decoration-dotted decoration-2 underline-offset-2${codeOnly ? ' lg:no-underline' : ''}`
      : '';
    const ring = isOpen ? `ring-2 ring-sky-500${codeOnly ? ' lg:ring-0' : ''}` : '';
    return (
      <mark
        key={idx}
        onClick={(e) => {
          e.stopPropagation();
          if (ann) onFocus(ann, e);
        }}
        title={title}
        className={`cursor-pointer rounded-sm ${bg} ${underline} ${ring}`}
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

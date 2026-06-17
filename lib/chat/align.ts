// Pure chat-replay alignment: project the participant's LLM-assistant messages
// onto the SAME recording timeline as the transcript and flags, and resolve which
// turn is "current" at a given playhead. No DOM, no I/O, no `server-only` — pure
// and unit-testable, importable anywhere (server action or client component).
//
// One clock. A turn's place on the timeline is `Date.parse(created_at) − anchorMs`,
// where `anchorMs` is the SAME recording anchor SessionPlayer uses for flags and
// observations (the `recordingStartedAt` prop parsed to ms). We do NOT recompute an
// anchor here — chat, flags, and transcript MUST share one timeline, so the caller
// passes the already-resolved `anchorMs`.
//
// `activeChatIndex` mirrors the LATEST-at-or-before semantics of a step rail (the
// current turn is the most recent one whose offset has passed), which is the OTHER
// resolution shape from `lib/transcript/active.ts:findActiveIndex` (tightest
// CONTAINING cue): chat turns are instantaneous points, not spans, so "contains" is
// meaningless; "the last turn that has happened" is the right notion of active.

/** The minimal message shape alignment reads. `app/actions/chat.ts`'s `ChatMessage`
 *  is structurally assignable to this — `alignChat` only needs the id, the role/
 *  content to carry through, and the `createdAt` instant to place on the clock. */
export type AlignableMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO-8601 timestamp (study `created_at`). Unparseable rows are dropped. */
  createdAt: string;
};

/** A chat message placed on the recording timeline: the display fields plus
 *  `offsetMs` = its position relative to the recording anchor (may be negative for
 *  a turn that happened before the anchor). */
export type ChatTurn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** `Date.parse(createdAt) − anchorMs`. Always finite — NaN-offset rows are dropped. */
  offsetMs: number;
};

/**
 * Place each message on the recording timeline and return the turns in playback
 * order. `offsetMs = Date.parse(createdAt) − anchorMs`. Rows whose `createdAt` is
 * unparseable (`Number.isNaN(Date.parse(...))`) are DROPPED so no NaN offset ever
 * reaches the timeline (NaN sorts unpredictably and never satisfies `≤ playhead`).
 * Sorted by `offsetMs` ascending. Does not mutate the input.
 *
 * `anchorMs` is the caller's already-resolved recording anchor in epoch ms (the
 * `recordingStartedAt` prop parsed once). A turn before the anchor yields a negative
 * offset; that is preserved, not clamped — the consumer decides how to render it.
 */
export function alignChat(messages: AlignableMessage[], anchorMs: number): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    const t = Date.parse(m.createdAt);
    if (Number.isNaN(t)) continue; // unparseable created_at: drop, no NaN offset
    turns.push({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      offsetMs: t - anchorMs,
    });
  }
  // Deterministic order: by timeline position, then by id, so two turns sharing an
  // `offsetMs` (a fast user+assistant pair on the same millisecond) have a stable,
  // reproducible order instead of depending on the engine's sort stability.
  turns.sort((a, b) => a.offsetMs - b.offsetMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return turns;
}

/**
 * Index of the turn that is "current" at `playheadMs` — the LATEST turn whose
 * `offsetMs ≤ playheadMs` — or -1 when the playhead precedes every turn (or the
 * list is empty). Expects `turns` sorted ascending by `offsetMs` (alignChat's
 * output). A boundary is inclusive: a playhead exactly on a turn's offset selects
 * that turn.
 *
 * A LINEAR scan from the end returns the last in-the-past turn directly. (At ~5
 * turn-pairs this is trivially cheap; a sorted-ascending list would also admit a
 * binary search, but the scale does not warrant it.)
 */
export function activeChatIndex(turns: ChatTurn[], playheadMs: number): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].offsetMs <= playheadMs) return i;
  }
  return -1;
}

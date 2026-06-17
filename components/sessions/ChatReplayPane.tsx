'use client';

import { useEffect, useRef } from 'react';
import type { ChatTurn } from '@/lib/chat/align';

// ---------------------------------------------------------------------------
// Time-aligned AI-chat replay pane (chat-replay feature, consumer task).
//
// Renders the participant's LLM-assistant conversation aligned to the SAME
// recording timeline as the transcript and flags. The whole conversation is
// always visible (aligned-scroll, not reveal-on-playhead — the chat is sparse,
// ~5 turn-pairs over a session, so a reveal pane would be empty ~95% of the
// time). As the video plays, the ACTIVE turn (latest turn whose offset has
// passed the playhead — `activeIndex`, computed by `activeChatIndex`) highlights
// and auto-scrolls into view; clicking a turn seeks the video to it.
//
// One mental model with the transcript pane: same sync paradigm, same
// BACKGROUND-ONLY active highlight idiom (a tint, never a padding/border/size
// change — the project has been bitten by marks that shift text), so switching
// attention between the two panes costs no extra extraneous load.
// ---------------------------------------------------------------------------

/** The display label for a turn's author. The study writes only `user`
 *  (the participant) and `assistant`; `user` reads as "Participant" so the
 *  pane speaks in the analyst's terms, not the API's. */
function roleLabel(role: ChatTurn['role']): string {
  return role === 'user' ? 'Participant' : 'Assistant';
}

export default function ChatReplayPane({
  turns,
  activeIndex,
  onSeek,
  fmtTime,
  hasMessages,
  anchorResolved,
  className,
}: {
  /** The aligned turns (alignChat output), ascending by `offsetMs`. */
  turns: ChatTurn[];
  /** Index of the turn current at the playhead (`activeChatIndex`), or -1. */
  activeIndex: number;
  /** Seek the video to a turn's recording offset (ms). The host's `seekTo`
   *  clamps to the seekable range, so a negative (pre-anchor) offset is safe. */
  onSeek: (offsetMs: number) => void;
  /** Format an ms offset as `mm:ss` (the host's shared transcript helper). */
  fmtTime: (ms: number) => string;
  /** Whether the participant has ANY recorded chat — distinguishes "no data"
   *  from "have data but can't place it on the timeline". */
  hasMessages: boolean;
  /** Whether the recording anchor resolved (a finite `anchorMs`). When false,
   *  offsets can't be computed, so the chat can't be placed on the timeline. */
  anchorResolved: boolean;
  /** Layout classes from the host (e.g. `h-[40vh] overflow-y-auto`). */
  className?: string;
}) {
  // Ref to the ACTIVE row so the auto-scroll effect can bring it into view as the
  // playhead advances. Only the active row is tracked (one element is enough).
  const activeRowRef = useRef<HTMLLIElement | null>(null);

  // Auto-scroll the active turn into view when it changes. Effect SCROLLS ONLY —
  // it never calls setState (the repo bans set-state-in-effect; reading a ref and
  // calling scrollIntoView is not state). Keyed on `activeIndex` so it fires once
  // per active-turn change, not on every render.
  useEffect(() => {
    if (activeIndex < 0) return;
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // Empty states are DISTINCT: "no chat recorded" (nothing to show) vs. "have
  // chat but the anchor is unset" (data exists but can't be placed on the clock).
  if (!hasMessages) {
    return (
      <div className={className}>
        <p className="p-3 text-sm text-foreground/50">
          No assistant chat recorded for this participant.
        </p>
      </div>
    );
  }
  if (!anchorResolved) {
    return (
      <div className={className}>
        <p className="p-3 text-sm text-foreground/50">
          Recording anchor not set — can&rsquo;t place chat on the timeline.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <ul className="space-y-px">
        {turns.map((turn, i) => {
          const isActive = i === activeIndex;
          return (
            <li
              key={turn.id}
              ref={isActive ? activeRowRef : undefined}
              // BACKGROUND-ONLY active highlight: a tint, no padding/border/size
              // change that would shift the text (matches the transcript <mark>
              // idiom). The border/padding/rounding are CONSTANT across states.
              className={`cursor-pointer rounded border border-transparent px-3 py-2 text-sm ${
                isActive ? 'bg-foreground/10' : 'hover:bg-foreground/[0.04]'
              }`}
              onClick={() => onSeek(turn.offsetMs)}
              aria-current={isActive ? 'true' : undefined}
            >
              <div className="mb-0.5 flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-foreground/70">
                  {roleLabel(turn.role)}
                </span>
                <span className="shrink-0 font-mono text-xs text-foreground/40">
                  {/* Clamp the LABEL at 0: align.ts preserves negative offsets for a
                      turn before the recording anchor, but formatTime(-1500) → "-1:-2".
                      Show 0:00 (the flags' pre-record convention); seek stays exact
                      because seekTo clamps to the seekable range itself. */}
                  [{fmtTime(Math.max(0, turn.offsetMs))}]
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-foreground/90">
                {turn.content}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

# Time-aligned AI-chat replay in the session coder — design

- **Date:** 2026-06-17
- **Branch:** `feat/session-chat-replay`
- **Status:** approved baseline (forks resolved 1a + 2b)

## Problem

When coding a think-aloud session the analyst sees video + transcript + flags, but
NOT the participant's chat with the LLM assistant. Coding "AI help vs. what they
think aloud" is a cross-stream convergence/divergence problem, so the chat must be
visible *aligned to the same recording timeline* as the transcript and flags.

## Locked decisions

- **Interaction model — aligned-scroll (fork 1a).** The whole conversation is
  always visible. The active turn (latest turn whose offset ≤ playhead) highlights
  and auto-scrolls into view as the video plays; clicking a turn seeks the video to
  it. Same sync paradigm as the transcript pane (one mental model, lower extraneous
  load). Chat here is sparse (~5 turn-pairs / ~33 min), which is *why* reveal-on-
  playhead was rejected — the pane would be empty ~95% of the time.
- **Content — dialogue text only (fork 2b).** User/assistant message text. The
  per-turn `state_spec` / `state_entities` snapshots are DEFERRED to a later
  increment (see Deferred).
- **Placement — one clock.** Each turn is placed at
  `Date.parse(created_at) − anchorMs`, where `anchorMs` is the SAME recording anchor
  SessionPlayer already uses for flags/observations (the `recordingStartedAt` prop,
  `app/(protected)/sessions/[id]/page.tsx:143`). Do NOT recompute an anchor — chat,
  flags, and transcript MUST share one timeline.
- **Layout — 50/50 vertical split, toggle.** When the chat pane is open the
  transcript scroll container shrinks `h-[80vh]` → `h-[40vh]` and the chat-replay
  pane renders below it at `h-[40vh]`. A header toggle shows/hides it; default
  hidden. Applies to BOTH the review and coding render branches.

## Data

- **Source:** `study_assistant_messages` (VT study DB `wuvtffnomynoafbilzxw`,
  READ-ONLY). Columns used: `id, user_id, role ('user'|'assistant'), content,
  created_at (timestamptz), module_id, scenario_idx`.
- **Join:** `study_assistant_messages.user_id → users.id → users.pid =
  cb_sessions.pid_label`.
- **Coverage (verified 2026-06-17):** PIDs `067`/`203`/`228` (coded sessions) have
  10 messages each; `411` has chat but no session. A session with no chat MUST
  render an empty-state, not crash.
- **Read-only invariant:** NO writes to study tables; `scripts/check-no-study-writes.sh`
  must stay green. Use the SAME read client the existing study-table reads use
  (`taskStartForPid` / `materializeAutoEpisodes` read `study_events`) and CONFIRM the
  coder JWT's SELECT actually returns rows for `study_assistant_messages` + `users`
  (an RLS-filtered empty set is the failure mode to rule out). Do NOT switch to a
  service-role client to work around a write — reads only.

## Deferred (YAGNI now)

- Per-turn `state_spec` / `state_entities` view (fork 2a).
- Replay-reveal interaction mode (fork 1b).
- `scenario_idx` / `module_id` segmentation UI.

## Tasks

### T1 — chat data layer (read + pure align)

- `app/actions/chat.ts`: `listSessionAssistantChat(sessionId): Promise<ChatMessage[]>`
  — resolve `pid_label` from `cb_sessions` (mirror `listObservationsForSession`),
  join `study_assistant_messages` via `users.pid`, return
  `{id, role, content, createdAt, moduleId, scenarioIdx}[]` ordered by `created_at`
  ascending. Read-only. Empty array (not throw) when the session/pid has no chat.
- `lib/chat/align.ts` (PURE — no I/O, no `server-only`): 
  - `alignChat(messages, anchorMs): ChatTurn[]` — `offsetMs = Date.parse(createdAt)
    − anchorMs`; sort by `offsetMs`; drop rows with unparseable `createdAt`.
  - `activeChatIndex(turns, playheadMs): number` — index of the latest turn with
    `offsetMs ≤ playheadMs`, else `−1` (mirror `lib/transcript/active.ts` semantics).
- Unit tests (`lib/chat/__tests__/align.test.ts`): offset math, ordering,
  active-index at boundaries / before-first / after-last / empty input.
- **Acceptance:** `tsc --noEmit` clean; `vitest` for `align.ts` green;
  `check-no-study-writes.sh` green.
- Model: standard (RLS read judgment).

### T2 — page wiring

- `app/(protected)/sessions/[id]/page.tsx`: load `listSessionAssistantChat(id)` and
  pass a `chatMessages` prop to `SessionPlayer`. Alignment happens client-side in T3
  using the EXISTING `recordingStartedAt` prop. Non-fatal if the load fails (fall
  back to `[]`, like episodes/observations).
- **Acceptance:** `tsc --noEmit` clean; page renders for a session with chat (`067`)
  and one without.
- Model: standard.

### T3 — ChatReplayPane + split + toggle

- `components/sessions/ChatReplayPane.tsx`: props
  `{ turns: ChatTurn[]; activeIndex: number; onSeek: (offsetMs: number) => void;
  fmtTime: (ms: number) => string }`. Renders each turn (role label + content +
  `mm:ss` offset); the active turn is highlighted BACKGROUND-ONLY (no padding/border
  that shifts text — matches the transcript `<mark>` idiom) and auto-scrolled into
  view; click a turn → `onSeek(offsetMs)`. Empty-state ("No assistant chat recorded
  for this participant") when `turns` is empty.
- `SessionPlayer`: add `showChat` state + a header toggle button (near the Sync
  toggle). When on, the transcript container goes `h-[80vh]` → `h-[40vh]` in BOTH the
  review and coding branches, and `<ChatReplayPane>` renders below at `h-[40vh]`.
  Compute `turns = alignChat(chatMessages, anchorMs)` where `anchorMs` derives from
  the `recordingStartedAt` prop (parse ISO → ms; a null anchor → pane shows an
  "anchor not set" hint, mirroring flags). `activeIndex =
  activeChatIndex(turns, playheadMs)` off the existing playhead state. `onSeek` →
  the existing `seekTo(offsetMs / 1000)`.
- **Acceptance:** `tsc --noEmit` + `lint` clean; `vitest` green; manual: toggle
  splits 50/50, active turn tracks playback, clicking a turn seeks.
- Model: standard→capable (multi-file integration in a large client component).

## Constraints (all tasks)

- Branch `feat/session-chat-replay`; NEVER commit to `main`; NEVER merge.
- This is a MODIFIED Next.js — read `AGENTS.md`, and read `node_modules/next/dist/docs/`
  before changing any Next API.
- Do NOT run `npm run build` / `next start` (shares `.next` with the running `:3200`
  dev server). Verify via `npx tsc --noEmit`, `npm run lint`, `npx vitest run`.
- Follow TDD; commit per task with a clear message; self-review before handing off.

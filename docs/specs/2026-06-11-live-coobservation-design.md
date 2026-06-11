# Live Co-Observation + Auto-Episode Timeline — Design Spec

**Date:** 2026-06-11
**Status:** Approved (decisions locked below) → writing-plans → subagent-driven-development
**Repo:** thematic-analysis (new branch off `feat/platform-foundation`)
**Predecessors:** SP-A platform foundation (cloud sessions, annotations, realtime, canonical), the episodes feature (`cb_episodes` + `cb_session_episodes`), the session player.

## Problem

While a participant works through the study, the researcher (facilitator) wants to make analysis easier by capturing in-the-moment interpretation, and have it land at the right place on the recording afterward. The recording (Zoom) is started manually only when the subject reaches the `task` module, so it has no shared clock with anything else.

## The one-clock insight (the architecture)

Three streams, **one clock — absolute UTC time**:

1. **Participant stream** — `study_events` (VT Supabase, same project as `cb_*`): `{user_id, study_id, module_id, event_type, payload, created_at}`. Absolute-timestamped, PID-keyed (`user_id` → `users.pid`). Already emits `module_start`, `step_advance` (read→ponder→revise), `spec_edit`, `map_vehicle_move`, `map_marker_*`, `retro_submit`, etc. This *is* a high-fidelity session log.
2. **Recording** — the only stream on a *relative* clock (t=0 = record start). Linked post-hoc via `cb_sessions` (already has `recording_started_at timestamptz`, `pid_label`, Drive video).
3. **Analyst stream** — the researcher's live interpretive flags (new).

Because the analyst flags and participant events are both absolute-timestamped, **neither needs the recording present at mark-time.** Alignment is a later join: `video_offset = created_at − recording_started_at`. Capturing the single anchor `recording_started_at` is the whole synchronization problem; **Zoom's API is not used.**

## Locked decisions

1. **Live marking = interpretive flags only** (not structural, not full coding). Read/ponder/revise/scenario boundaries are *auto-derived* from `step_advance`/`module_start`. (Researcher choice: A.)
2. **Anchor = auto, +2 s correction.** `recording_started_at` = the `created_at` of the `type:'task'` `module_start` event for that PID **plus `ANCHOR_CORRECTION_MS` = 2000** (one named, tunable constant) to absorb record-start reaction time so markers land on the moment without scrubbing. No live button, no Zoom. (Choice: 1, with offset.)
3. **Live feed = lightweight.** Current module/step + a running clock — not a full scrolling event feed. The researcher is already watching the participant on Zoom; the rich timeline is reconstructed at *review*. (Choice: a.) The live "current step" is read via **polling** (every 3 s) of the latest `study_event` for the PID — no change to the study-table realtime publication, stays read-only.
4. **Custom flag taxonomy.** Flags are researcher-defined presets (`cb_flag_types`), editable like episode presets — not a fixed Confusion/Aha/etc. list.
5. **No codebook editing on the live screen.** The researcher edits codes/flags in a separate tab. The live screen is a minimal note-capture surface.
6. **Read-only study tables preserved.** All reads of `study_events`/`users` go through the existing read-only path (`cbFrom` guard forbids writes to study tables). The new writes are to `cb_*` tables only.

## Components

### A. Flag taxonomy — `cb_flag_types` (editable presets)
- Table `cb_flag_types { id, codebook_id fk, label text, color text null, position int, created_at }`. RLS: `authenticated` read/write (same posture as `cb_episodes`).
- Actions in `app/actions/flag-types.ts`: `listFlagTypes(codebookId)`, `createFlagType`, `renameFlagType`, `deleteFlagType`, `reorderFlagTypes` (mirror `app/actions/episodes.ts`).
- A small manager UI (route or panel, mirrors `EpisodeManager`) to add/rename/reorder/delete flag types. Reached from `CodebookNav`.

### B. Live observations — `cb_observations`
- Table `cb_observations { id, pid text, session_id uuid null references cb_sessions(id) on delete set null, flag_type_id uuid null references cb_flag_types(id) on delete set null, body text, created_at timestamptz default now(), created_by uuid references auth.users }`.
  - **PID-keyed, session-agnostic at write time** (`session_id` linked later). `created_at` is the absolute anchor for alignment. `flag_type_id` optional (a note can be a bare text note); `body` optional (a flag can be tap-only).
- RLS: read for `authenticated`; insert/update/delete where `created_by = auth.uid()` (own observations), mirroring `cb_annotations`.
- Actions in `app/actions/observations.ts`: `addObservation({pid, flagTypeId?, body?})` (created_by = auth.uid, created_at = now()), `listObservationsForPid(pid)`, `listObservationsForSession(sessionId)` (join by `pid_label`), `updateObservation`, `deleteObservation`.

### C. Live Follow view — `/sessions/live`
- **Participant picker:** a dropdown of `users` (`pid` + `first_name`, read-only) to set the active PID. Persist the active PID in the URL (`?pid=`) so a reload resumes.
- **Current-step indicator (polled, 3 s):** query the latest `study_event` for the PID (join `users`), humanize it ("Scenario 2 · revise", "editing specification", "moved vehicle"). Show the current `module_id`'s humanized step.
- **Running clock = provisional video clock.** Once the PID has a `module_start` for the `type:'task'` module, the clock shows `now − task_module_start.created_at` (mm:ss) — i.e., the elapsed time that *will become* the video offset. Before the task module, it reads "task not started." This previews where a flag will land in the eventual recording.
- **Flag bar:** one row of buttons, one per `cb_flag_types` row (label + color). Tapping writes `addObservation({pid, flagTypeId})` immediately (optimistic). An optional single-line text input writes `addObservation({pid, flagTypeId?, body})` on Enter. Keyboard shortcuts (1–9) map to the first N flag types for eyes-free tapping. This is the *entire* live interaction — one tap, no attention drain.
- **Today's observations list:** a thin reverse-chronological list of this PID's observations (flag + note + clock-relative time), each deletable (mis-taps happen). No video here (none yet).

### D. Anchor + auto-episodes (at link/upload time)
- When a recording is linked to a session for a PID (existing upload flow sets `cb_sessions.pid_label`), set `recording_started_at` automatically:
  - Resolve `user_id` from `users.pid = pid_label`.
  - Resolve the `type:'task'` `module_id` from the active study's `authored_data` (the recorded module).
  - `recording_started_at = min(created_at) of study_events where user_id=… and module_id=… and event_type='module_start'` **+ `ANCHOR_CORRECTION_MS` (a single named constant = `2000`)**, so markers land on the moment without scrubbing.
  - If absent (no task event), leave null and surface "anchor unset — set manually" (a manual fallback: pick any event/observation and declare its video position; out of MVP scope, flagged).
- **Auto-episodes:** at link time, derive episode marks from `study_events` for the PID and materialize into `cb_session_episodes` (so they sit beside the researcher's own marks): each `step_advance`/`module_start` boundary → a `cb_session_episodes` row with `t_start_ms = created_at − recording_started_at`, `episode_id` mapped from a step→episode lookup. **The researcher owns episodes** — the existing `cb_episodes` manager (create/rename/reorder/delete) is the source of truth; the auto-derivation maps step boundaries onto *existing* presets by a case-insensitive name match (intro/initial-spec/read/ponder/revise) and only auto-creates a `cb_episodes` row when no matching preset exists (idempotent, and the researcher may then rename/merge it). Negative offsets (events before record start) are clamped to 0 / dropped.

### E. Review timeline (extends the session player)
- In the existing session page, render `cb_observations` for the session's PID as **clickable markers** on the transcript/video timeline at `offset = created_at − recording_started_at`; clicking seeks the video. Color by flag type; show the note on hover/click.
- Auto-episodes (materialized in `cb_session_episodes`) already render via the episodes feature; they now populate from the event log.
- (Optional, post-MVP) a fine "participant actions" track from the raw `study_events`.

## Data flow

```
LIVE:  researcher picks PID → polls latest study_event (read-only) → taps flag
       → cb_observations{pid, flag_type_id, created_at=now()}            [absolute]
LINK:  upload recording → cb_sessions{pid_label, video} ; auto-set
       recording_started_at = task module_start.created_at ; materialize
       cb_session_episodes from study_events
REVIEW: session player joins cb_observations by pid_label, renders markers at
       (created_at − recording_started_at); episodes already on the timeline
```

## Out of scope (later)
- Manual anchor fallback UI (landmark nudge) — auto-anchor only for MVP.
- Live realtime event feed (chose lightweight polling).
- Frame-exact anchoring / Zoom API.
- Multi-session-per-PID (study is 1 PID = 1 recorded session).
- Editing auto-episodes' step→episode mapping in the UI.

## Verification
- `cb_flag_types` CRUD + manager UI; flags render on the live bar.
- Live view: pick a PID → current step polls + humanizes; clock starts at the task `module_start`; tapping a flag writes a `cb_observations` row with `created_at≈now`, `pid`, `flag_type_id`, `created_by=auth.uid()`; a second account cannot delete it (RLS); note via text input writes `body`.
- Anchor: linking a recording for a PID with a task `module_start` sets `recording_started_at` to that event's `created_at` (verified against a known event); auto-episodes appear in `cb_session_episodes` at correct offsets.
- Review: observations render as markers at `created_at − recording_started_at`; clicking seeks; colors match flag types.
- Study tables untouched (lint guard + `study_events` row-count unchanged); reads only.
- `tsc`/`lint`/`build`/`test` green.

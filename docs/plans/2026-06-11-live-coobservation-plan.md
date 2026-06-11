# Live Co-Observation — Implementation Plan

> Execute via superpowers:subagent-driven-development. Source spec: `docs/specs/2026-06-11-live-coobservation-design.md`. Branch: `feat/live-coobservation` (off `feat/platform-foundation`).

**Goal:** Let the researcher drop timestamped interpretive flags while a participant works, auto-anchor the recording to the participant's event clock, and surface those flags + auto-episodes on the review timeline.

**Architecture:** Three streams, one absolute clock. New `cb_flag_types` (editable taxonomy) + `cb_observations` (PID-keyed, `created_at`-absolute). Live view at `/sessions/live`. Auto-anchor `recording_started_at = task module_start.created_at + 2000ms`. Auto-episodes materialize from `study_events` into `cb_session_episodes`. Review markers in the session player.

**Stack:** Next 16.2.6 (read `node_modules/next/dist/docs/` first), Supabase VT `wuvtffnomynoafbilzxw`, `@supabase/ssr` + service-role (`cbFrom` guard — study tables read-only), Supabase Auth. Verify with `npx next start -p 3201` against a fresh build. Migrations via `vt-supabase` MCP + regen `lib/types/cb-db.ts`; SQL mirrored to `docs/migrations/`.

---

### Task 1 — Flag taxonomy: `cb_flag_types` + actions + manager UI
**Files:** migration `docs/migrations/18_flag_types.sql`; `app/actions/flag-types.ts`; `app/(protected)/flag-types/page.tsx` + `components/flags/FlagTypeManager.tsx`; `app/(protected)/CodebookNav.tsx`; `lib/types/cb-db.ts`.
- Migration: `cb_flag_types { id uuid pk, codebook_id uuid fk cb_codebooks on delete cascade, label text not null, color text, position int not null default 0, created_at timestamptz default now() }`; index on `codebook_id`; RLS `for all to authenticated using(true) with check(true)`.
- Actions (mirror `app/actions/episodes.ts`): `listFlagTypes(codebookId)`, `createFlagType(codebookId,{label,color})` (append position via `cbFrom`), `renameFlagType`, `deleteFlagType`, `reorderFlagTypes(ids)`.
- Manager UI mirrors `EpisodeManager` (list + add + inline rename + color swatch + ↑/↓ + delete). Add "Flags" to `CodebookNav`.
- **Acceptance:** CRUD round-trip against live DB (create→list→rename→reorder→delete), cleaned up; `/flag-types` renders 200; tsc/lint/build/test green; study tables untouched.

### Task 2 — Live observations: `cb_observations` + actions
**Files:** migration `docs/migrations/19_observations.sql`; `app/actions/observations.ts`; `lib/types/cb-db.ts`.
- Migration: `cb_observations { id uuid pk, pid text not null, session_id uuid null references cb_sessions on delete set null, flag_type_id uuid null references cb_flag_types on delete set null, body text, created_at timestamptz not null default now(), created_by uuid references auth.users }`; indexes on `(pid, created_at)` and `session_id`; RLS: select `to authenticated using(true)`; insert/update/delete `using/with check (created_by = auth.uid())`.
- Actions: `addObservation({pid, flagTypeId?, body?})` (user client so `created_by=auth.uid()`, `created_at` server default), `listObservationsForPid(pid)` → `[{id, pid, flagTypeId, flagLabel, color, body, createdAt}]` (join flag types), `listObservationsForSession(sessionId)` (resolve `pid` via `cb_sessions.pid_label`, then by pid), `updateObservation(id,{body})`, `deleteObservation(id)`.
- **Acceptance:** insert as user A (created_by=A) → row; user B cannot delete A's row (RLS) but can read it; list-by-pid returns it with flag label/color; cleaned up; tsc/lint/build/test green.

### Task 3 — Live Follow view `/sessions/live`
**Files:** `app/(protected)/sessions/live/page.tsx`; `components/live/LiveFollow.tsx`; a read-only action `app/actions/live.ts` (`listParticipants()` → `users.pid+first_name`; `latestEventForPid(pid)` → `{moduleId, eventType, payload, createdAt}`; `taskStartForPid(pid)` → the `type:'task'` `module_start.created_at` or null — all read-only via `cbFrom` SELECT on study tables, never writing).
- PID picker (dropdown of participants), active PID in `?pid=`. Poll `latestEventForPid` every 3s; humanize event→step label (a pure `lib/live/humanize.ts`, unit-tested: maps `event_type`+payload+module to "Scenario 2 · revise" etc.). Running clock = `now − taskStart` (mm:ss) once taskStart exists, else "task not started".
- Flag bar from `listFlagTypes` (label+color buttons; number keys 1–9); tap → `addObservation({pid, flagTypeId})` optimistic. Optional single-line note input → `addObservation({pid, flagTypeId?, body})` on Enter. Reverse-chron list of this PID's observations (clock-relative time), each deletable.
- Add "Live" to `CodebookNav`.
- **Acceptance:** pick a PID with events → current step humanizes + clock counts from task start; tapping a flag writes a `cb_observations` row (verified in DB, created_by=auth.uid, pid correct); note writes body; delete removes; `humanize` unit tests pass; render 200; tsc/lint/build/test green; study tables read-only (lint guard + row count unchanged).

### Task 4 — Auto-anchor (+2s) + auto-episode materialization
**Files:** `lib/live/anchor.ts` (`ANCHOR_CORRECTION_MS = 2000`); extend the session link/upload flow in `app/actions/sessions.ts`; `app/actions/episodes.ts` (a `materializeAutoEpisodes(sessionId)`).
- On link (a session gains a `pid_label`): resolve `user_id` from `users.pid`; resolve the `type:'task'` `module_id` from the active study's `authored_data` (read-only); `recording_started_at = min(module_start.created_at) + ANCHOR_CORRECTION_MS`. If no task event → leave null + report "anchor unset".
- `materializeAutoEpisodes`: read the PID's `step_advance`/`module_start` events; for each boundary, upsert a `cb_session_episodes` row at `t_start_ms = created_at − recording_started_at` (clamp <0 to 0/drop); map step→episode by case-insensitive name match on existing `cb_episodes`, auto-create only when absent (idempotent — re-running doesn't duplicate). A pure `lib/live/episodes-from-events.ts` (event list + anchor → episode marks) unit-tested.
- **Acceptance:** for a known PID+task event, anchor = that event's `created_at + 2000ms` (asserted to the ms); `materializeAutoEpisodes` produces correct offsets + no duplicates on re-run; pure mapper unit-tested; tsc/lint/build/test green; study tables read-only.

### Task 5 — Review markers in the session player
**Files:** `components/sessions/SessionPlayer.tsx`; `app/(protected)/sessions/[id]/page.tsx` (load `listObservationsForSession`).
- Render observations as clickable markers at `offset = createdAt − recording_started_at` on the transcript/time rail; color by flag type; show body on click/hover; click → `seekTo(offset)`. A "Flags" tab/section in the rail listing them (jump + the note). Skip markers with no anchor (recording_started_at null).
- **Acceptance:** a session with observations renders markers at correct offsets; clicking seeks; colors match flag types; render 200; tsc/lint/build/test green.

---
**Final:** full verification sweep (tsc/lint/build/test), confirm `study_events` row count unchanged + `cbFrom` guard clean, push `feat/live-coobservation`, open PR. (Local tool — no prod deploy.)

-- Migration 24_recording_marks
-- Live co-observation: MANUAL recording-start anchor (primary; auto becomes the
-- fallback).
--
-- The recording (Zoom) is on a RELATIVE clock (t=0 = record start); every other
-- stream (participant study_events, analyst observations) is on the ABSOLUTE UTC
-- clock. Capturing the single anchor recording_started_at (in absolute time) is
-- the whole synchronization problem; alignment is then a subtraction.
--
-- Previously that anchor was DERIVED automatically (task module_start +
-- ANCHOR_CORRECTION_MS, the +2s record-start reaction correction). This table
-- lets the researcher capture the EXACT instant they hit "record" instead: one
-- row PER participant (pid is the PK), started_at = now() at the click. The upload
-- anchor path then prefers cb_recording_marks.started_at (exact, NO +2s) when it
-- exists, and falls back to the auto +2s derivation when it does not.
--
-- Re-hitting "Start recording" RESETS the mark (the action upserts on the pid PK,
-- overwriting started_at) — a mis-click is corrected by clicking again, or cleared
-- outright (clearRecordingStart). marked_by records who placed the mark.
--
-- RLS: cb_ config-style — read+write open to `authenticated` (mirrors
-- cb_episodes' cb_ep_all). Additive cb_ only; does NOT touch study/users tables.

create table cb_recording_marks (
  pid text primary key,
  started_at timestamptz not null default now(),
  marked_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table cb_recording_marks enable row level security;
create policy cb_rm_all on cb_recording_marks for all to authenticated using (true) with check (true);

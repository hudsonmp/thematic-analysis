-- Migration 19_observations
-- Live co-observation (Task 2 of 5): the per-observation DATA LAYER.
--
-- An "observation" is one thing a co-observer logged about a participant during a
-- live session: a tap of a preset FLAG (cb_flag_types, migration 18) — e.g.
-- "Confusion" at this moment — and/or a free-text NOTE. The row is keyed on `pid`
-- (the participant label) so observations persist independently of any one session
-- recording: `session_id` is a nullable, on-delete-set-null link to the live
-- cb_sessions row (a tap can be made before a session row exists, and survives the
-- session's deletion), and `flag_type_id` is likewise nullable / set-null (a
-- bare note has no flag; a flag deleted from the taxonomy leaves its taps intact).
-- At least one of (flag_type_id, body) is meaningful — the server action rejects a
-- both-null observation; the table itself does not constrain this (a future
-- migration could add a CHECK, but the action is the single write path).
--
-- `(pid, created_at)` index drives the per-participant timeline read (the live view
-- and post-hoc playback list a pid's observations in time order). `session_id`
-- index drives the session-scoped read. `recording_started_at` lives on
-- cb_sessions (migration 10); Task 5 computes each observation's video offset as
-- (created_at - recording_started_at), so no offset column is stored here.
--
-- RLS — read-all / write-own, mirroring cb_annotations (migration 11):
--   * cb_obs_read   — SELECT open to `authenticated` (using(true)): observations
--                     are shared context across co-observers (the live view shows
--                     everyone's taps), so reads are not owner-scoped.
--   * cb_obs_insert — own-only: with check (created_by = auth.uid()); the action
--                     sets created_by explicitly to the signed-in user.
--   * cb_obs_update — own-only: using + with check (created_by = auth.uid()).
--   * cb_obs_delete — own-only: using (created_by = auth.uid()); a delete of
--                     another observer's row matches zero rows (silent no-op).
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table cb_observations (
  id uuid primary key default gen_random_uuid(),
  pid text not null,
  session_id uuid references cb_sessions(id) on delete set null,
  flag_type_id uuid references cb_flag_types(id) on delete set null,
  body text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index on cb_observations(pid, created_at);
create index on cb_observations(session_id);
alter table cb_observations enable row level security;
create policy cb_obs_read on cb_observations for select to authenticated using (true);
create policy cb_obs_insert on cb_observations for insert to authenticated with check (created_by = auth.uid());
create policy cb_obs_update on cb_observations for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy cb_obs_delete on cb_observations for delete to authenticated using (created_by = auth.uid());

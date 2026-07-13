-- Migration 33_session_coding_status
-- Per-coder "I've done thematic analysis on this session" marks.
--
-- A row is BINARY and keyed on (session_id, coder_id): ROW PRESENT = that coder
-- marked the session done; ROW ABSENT = not done. There is no status enum and no
-- "in progress" — marking is the only state transition (insert), unmarking is a
-- delete. `done_at` records WHEN the mark was placed (server default), not a
-- status; it carries no semantics beyond provenance.
--
-- The mark is PER-CODER, mirroring cb_observations.created_by / cb_annotations.
-- coder_id: each coder marks their OWN completion, and the index reads one
-- coder's done-set (the `/sessions` list shows the signed-in coder's progress).
-- The composite primary key (session_id, coder_id) makes a coder's mark on a
-- given session idempotent — re-marking upserts onto the same row.
--
-- RLS — read-all / write-own, mirroring cb_observations (migration 19) EXACTLY,
-- keyed on `coder_id = auth.uid()`:
--   * cb_scs_read   — SELECT open to `authenticated` (using(true)): completion is
--                     shared context (a Compare/coordination view could show who
--                     has finished), so reads are not owner-scoped.
--   * cb_scs_insert — own-only: with check (coder_id = auth.uid()); the action
--                     sets coder_id explicitly to the signed-in user.
--   * cb_scs_update — own-only: using + with check (coder_id = auth.uid()).
--   * cb_scs_delete — own-only: using (coder_id = auth.uid()); an unmark of
--                     another coder's row matches zero rows (silent no-op).
--
-- The coder_id index drives the per-coder done-set read (`where coder_id = ?`).
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table if not exists cb_session_coding_status (
  session_id uuid not null references cb_sessions(id) on delete cascade,
  coder_id uuid not null references auth.users(id) on delete cascade,
  done_at timestamptz not null default now(),
  primary key (session_id, coder_id)
);

alter table cb_session_coding_status enable row level security;

-- Read-all (coordination/Compare), write-own (per-coder completion).
create policy cb_scs_read on cb_session_coding_status for select to authenticated using (true);
create policy cb_scs_insert on cb_session_coding_status for insert to authenticated with check (coder_id = auth.uid());
create policy cb_scs_update on cb_session_coding_status for update to authenticated using (coder_id = auth.uid()) with check (coder_id = auth.uid());
create policy cb_scs_delete on cb_session_coding_status for delete to authenticated using (coder_id = auth.uid());

create index on cb_session_coding_status(coder_id);

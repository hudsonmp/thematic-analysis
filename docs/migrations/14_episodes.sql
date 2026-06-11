-- Migration 14_episodes
-- Feature #5: preset episodes + assign-episode-at-timecode for session navigation/resumability.
--
-- An "episode" is a meaningful chunk of a session (e.g. "Scenario 1 read", "revise",
-- a custom phase) the researcher wants to mark for navigation/resumability. The model
-- has two tables, mirroring the facet/value preset → per-session-mark split:
--
--   * cb_episodes          — the codebook-scoped PRESET list of episode names. The
--                            researcher curates these once per codebook (add / rename /
--                            reorder / delete), like the facet editor. `position` gives a
--                            stable display order (append after max on create).
--   * cb_session_episodes  — a MARK: "episode X starts at t_start_ms in this session".
--                            While coding, the coder picks a preset episode and marks the
--                            current video timecode; the session timeline then shows these
--                            boundaries to jump between / resume from. `t_end_ms` is optional
--                            (a span can be closed later; SP marks a start point). `marked_by`
--                            records who placed the mark (auth.uid()).
--
-- RLS (matches the read-all collaboration model of cb_annotations):
--   * cb_episodes          — codebook config: read+write open to `authenticated`
--                            (cb_ep_all: for all, using(true) with check(true)).
--   * cb_session_episodes  — read-all (so any coder can navigate by episode), write open
--                            to `authenticated` (cb_se_read select; cb_se_write for all).
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table cb_episodes (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  name text not null, description text, position int not null default 0,
  created_at timestamptz not null default now()
);
create table cb_session_episodes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cb_sessions(id) on delete cascade,
  episode_id uuid not null references cb_episodes(id) on delete cascade,
  t_start_ms int not null, t_end_ms int,
  marked_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index on cb_episodes(codebook_id);
create index on cb_session_episodes(session_id, t_start_ms);
alter table cb_episodes enable row level security;
alter table cb_session_episodes enable row level security;
create policy cb_ep_all on cb_episodes for all to authenticated using (true) with check (true);
create policy cb_se_read on cb_session_episodes for select to authenticated using (true);
create policy cb_se_write on cb_session_episodes for all to authenticated using (true) with check (true);

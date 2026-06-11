-- Migration 15_code_episodes
-- Feature #10: episode tags on codes (for findability).
--
-- A researcher curates a PRESET list of episodes per codebook (cb_episodes,
-- migration 14) — meaningful protocol chunks like "Scenario 1 read" or "revise".
-- This migration adds a join table so a code can be TAGGED with the episodes it
-- pertains to, independent of any session. The matrix can then filter codes by
-- episode (compose with the existing text search), and the code card carries an
-- episode-tag editor.
--
-- Model: a plain many-to-many junction keyed on (code_id, episode_id) — the same
-- shape as cb_code_facet_values (migration 02). No own id, no extra columns; the
-- composite PK is the dedupe key. Both FKs cascade on delete so deleting a code
-- or a preset episode reaps its tags.
--
-- RLS mirrors cb_code_facet_values / cb_episodes: codebook config, read+write
-- open to `authenticated` (cb_ce_all: for all, using(true) with check(true)).
-- Writes route through the service-role client (cbFrom), like the facet-value
-- tags, so the open policy is the collaboration model, not the access boundary.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table cb_code_episodes (
  code_id uuid not null references cb_codes(id) on delete cascade,
  episode_id uuid not null references cb_episodes(id) on delete cascade,
  primary key (code_id, episode_id)
);
create index on cb_code_episodes(code_id);
alter table cb_code_episodes enable row level security;
create policy cb_ce_all on cb_code_episodes for all to authenticated using (true) with check (true);

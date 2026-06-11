-- Migration 18_flag_types
-- Live co-observation (Task 1 of 5): the editable FLAG TAXONOMY.
--
-- A "flag type" is a codebook-scoped, named tag a co-observer can raise during a
-- live session (e.g. "Confusion", "Aha", "Off-task"). The researcher curates this
-- PRESET list once per codebook — add / rename (and recolor) / reorder / delete —
-- exactly like the preset-episodes editor (cb_episodes, migration 14). `position`
-- gives a stable display order (append after max on create). `color` is an
-- optional hex string the UI shows as a swatch.
--
-- This migration adds ONLY the preset taxonomy. The per-observation rows that
-- reference a flag type at a live timecode arrive in a later task; nothing here
-- depends on them.
--
-- RLS (matches the read-all collaboration model of cb_episodes config):
--   * cb_flag_types — codebook config: read+write open to `authenticated`
--                     (cb_ft_all: for all, using(true) with check(true)).
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table cb_flag_types (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  label text not null,
  color text,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index on cb_flag_types(codebook_id);
alter table cb_flag_types enable row level security;
create policy cb_ft_all on cb_flag_types for all to authenticated using (true) with check (true);

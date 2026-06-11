-- Migration 20_labels
-- LABELS: a flat, codebook-scoped vocabulary for organizing/grouping CODES by
-- theme.
--
-- A "label" is a researcher-created tag (e.g. "Metacognition", "Surface
-- strategy") that a code can carry to group it with other thematically-related
-- codes. The researcher curates this PRESET list once per codebook — add /
-- rename (and recolor) / reorder / delete — exactly like the preset-episodes
-- editor (cb_episodes, migration 14) and the flag taxonomy (cb_flag_types,
-- migration 18). `position` gives a stable display order (append after max on
-- create). `color` is an optional hex string the UI shows as a swatch.
--
-- This is the CATEGORICAL / "what kind" axis for codes — independent of the
-- temporal axis (cb_episodes / cb_code_episodes), of facets (cb_facets), of
-- flag types, and of observations. cb_code_labels is the many-to-many junction
-- tagging a code with a label, modeled on cb_code_episodes (migration 15): a
-- plain (code_id, label_id) composite PK, both FKs `on delete cascade`, so
-- deleting either a code or a label removes the tag with no orphans.
--
-- RLS (matches the read-all collaboration model of cb_episodes / cb_flag_types
-- config):
--   * cb_labels       — codebook config: read+write open to `authenticated`
--                       (cb_lbl_all: for all, using(true) with check(true)).
--   * cb_code_labels  — the tag junction: read+write open to `authenticated`
--                       (cb_cl_all: for all, using(true) with check(true)).
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables, nor
-- episodes/events, facets, flags, or observations.

create table cb_labels (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  name text not null, color text, position int not null default 0,
  created_at timestamptz not null default now()
);
create index on cb_labels(codebook_id);
create table cb_code_labels (
  code_id uuid not null references cb_codes(id) on delete cascade,
  label_id uuid not null references cb_labels(id) on delete cascade,
  primary key (code_id, label_id)
);
create index on cb_code_labels(code_id);
alter table cb_labels enable row level security;
alter table cb_code_labels enable row level security;
create policy cb_lbl_all on cb_labels for all to authenticated using (true) with check (true);
create policy cb_cl_all on cb_code_labels for all to authenticated using (true) with check (true);

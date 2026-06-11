-- Migration 22_facet_types
-- FACET TYPES: give every facet a TYPE that fixes how a code carries it.
--
-- Until now a facet was implicitly "enum": a value-bearing dimension whose codes
-- are tagged with one (cardinality 'single') or many (cardinality 'multi') of its
-- cb_facet_values (junction cb_code_facet_values, migration 02). That stays the
-- default and is unchanged.
--
-- This migration introduces two valueless facet kinds alongside enum:
--   * 'boolean'   — a yes/no per code (no cb_facet_values). cardinality is moot.
--   * 'open_text' — a free-text note per code (no cb_facet_values). cardinality
--                   is moot.
-- Their per-code datum lives in a NEW table cb_code_facet_fields keyed on
-- (code_id, facet_id): bool_value for booleans, text_value for open_text. A row
-- is present iff the code carries a value on that facet; clearing the field
-- deletes the row (null/empty => no row). enum facets do NOT use this table —
-- they keep writing cb_code_facet_values, so existing data and the matrix pivot
-- (which reads cb_facet_values) are untouched.
--
-- cb_facets.type defaults to 'enum', so every pre-existing facet is enum with no
-- behavior change. The check constraint pins the three legal kinds.
--
-- cb_code_facet_fields mirrors the read-all collaboration RLS of the other cb_
-- junctions (cb_code_facet_values / cb_code_episodes / cb_code_labels): read+write
-- open to `authenticated`; writes route through the service-role client (cbFrom),
-- so the open policy is the collaboration model, not the access boundary. Both
-- FKs cascade on delete so reaping a code or a facet reaps its fields with no
-- orphans.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables, nor
-- cb_facet_values / cb_code_facet_values (enum storage is unchanged).

alter table cb_facets add column type text not null default 'enum'
  check (type in ('enum','boolean','open_text'));

create table cb_code_facet_fields (
  code_id uuid not null references cb_codes(id) on delete cascade,
  facet_id uuid not null references cb_facets(id) on delete cascade,
  bool_value boolean,
  text_value text,
  primary key (code_id, facet_id)
);
create index on cb_code_facet_fields(code_id);
alter table cb_code_facet_fields enable row level security;
create policy cb_cff_all on cb_code_facet_fields for all to authenticated using (true) with check (true);

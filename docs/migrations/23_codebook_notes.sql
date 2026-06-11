-- Migration 23_codebook_notes
-- CODEBOOK NOTES: one free-form, researcher-authored notes document per codebook.
--
-- The "Instructions" page is where the researcher writes their OWN running notes
-- ("how to do stuff" — coding conventions, reminders, decisions). It is a single
-- plain-text / markdown body PER codebook (a 1:1 row keyed on codebook_id, the
-- PK), autosaved as they type. There is no versioning, no per-section structure,
-- no sharing model beyond the codebook itself — it is a scratchpad, distinct from
-- the formal protocol/anatomy/scheme surfaces.
--
-- `body` defaults to '' so getCodebookNotes can treat a missing row as "no notes
-- yet" and the editor renders empty; `updated_at` is bumped on every save (the
-- upsert sets it) to power a "saved" hint. `on delete cascade` removes the note
-- with its codebook.
--
-- RLS (matches the read-all collaboration model of the other cb_ config tables,
-- e.g. cb_labels / cb_flag_types): a single cb_notes_all policy, for all to
-- `authenticated`, using(true) with check(true). App writes go through cbFrom
-- (service role), so the policy is the collaborator-facing read/write rule.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table cb_codebook_notes (
  codebook_id uuid primary key references cb_codebooks(id) on delete cascade,
  body text not null default '',
  updated_at timestamptz not null default now()
);
alter table cb_codebook_notes enable row level security;
create policy cb_notes_all on cb_codebook_notes for all to authenticated using (true) with check (true);

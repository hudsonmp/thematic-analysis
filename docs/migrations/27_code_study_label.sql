-- 27_code_study_label.sql
-- Per-code authoring study (Task 4): record which study/collection a code was
-- authored under, system-assigned at create time (mirrors the citation facet's
-- "system-assigned" feel). Sourced from the current session's `collection` when a
-- code is created from the session coding panel; null when created from the
-- standalone codebook page (no session context). Free-text label, not an FK —
-- "study" here is the session collection grouping (e.g. 'pilots'), not the
-- IRB-owned `studies` table.
alter table cb_codes
  add column if not exists study_label text;

comment on column cb_codes.study_label is
  'The study/collection (cb_sessions.collection) under which this code was authored; null if created outside a session context.';

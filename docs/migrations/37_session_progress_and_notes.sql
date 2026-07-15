-- 37_session_progress_and_notes.sql
-- (Applied 2026-07-15.) 4-state session progress + shared note + reconciliation flag.
-- Per-coder status on cb_session_coding_status (ABSENT row = not_started); existing
-- "done" rows mean the coder finished their independent pass -> 'individual_coding'
-- via the default. Reconciliation is a SESSION-level display override; note is a
-- shared coordination channel. cb_ only; study tables untouched.
alter table cb_session_coding_status
  add column if not exists status text not null default 'individual_coding'
  check (status in ('in_progress', 'individual_coding'));
alter table cb_sessions add column if not exists reconciliation_at timestamptz;
alter table cb_sessions add column if not exists note text;

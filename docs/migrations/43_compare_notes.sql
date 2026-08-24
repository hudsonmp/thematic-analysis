-- 43_compare_notes — the per-viewer REVIEW LAYER on the compare screen.
--
-- A compare note is one coder's remark about a segment's coding during
-- reconciliation: either a note-to-self ('comment') or a request that the
-- OTHER coder change their coding there ('change_request', about_coder_id =
-- the addressee). Notes are interpretation, not coding — they never touch
-- cb_annotations.
--
-- Visibility: readable by any authed member (reconciliation is a shared
-- conversation; the UI filters each viewer's panel to their own notes plus
-- requests addressed to them). Writable only by the author (RLS).

create table if not exists cb_compare_notes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cb_sessions(id) on delete cascade,
  segment_id uuid not null references cb_segments(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  -- whose coding the note concerns; null = a general note on the segment.
  about_coder_id uuid references auth.users(id),
  kind text not null check (kind in ('comment', 'change_request')),
  body text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cb_compare_notes_session_idx on cb_compare_notes (session_id);

alter table cb_compare_notes enable row level security;

drop policy if exists cb_compare_notes_read on cb_compare_notes;
create policy cb_compare_notes_read on cb_compare_notes
  for select using (auth.uid() is not null);

drop policy if exists cb_compare_notes_insert on cb_compare_notes;
create policy cb_compare_notes_insert on cb_compare_notes
  for insert with check (author_id = auth.uid());

-- The ADDRESSEE of a change_request must be able to resolve it (set
-- resolved_at), so update admits author OR addressee. Column-level narrowing
-- isn't expressible in RLS; the two-researcher team makes the wider grant
-- acceptable, and the app only ever writes resolved_at from the addressee path.
drop policy if exists cb_compare_notes_update on cb_compare_notes;
create policy cb_compare_notes_update on cb_compare_notes
  for update using (author_id = auth.uid() or about_coder_id = auth.uid())
  with check (author_id = auth.uid() or about_coder_id = auth.uid());

drop policy if exists cb_compare_notes_delete on cb_compare_notes;
create policy cb_compare_notes_delete on cb_compare_notes
  for delete using (author_id = auth.uid());

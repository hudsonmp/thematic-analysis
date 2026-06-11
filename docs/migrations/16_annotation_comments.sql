-- Migration 16_annotation_comments
-- Features #17/#18: Google-Docs-style comments anchored to a highlighted excerpt.
--
-- A comment is NOT a session-level note (that is cb_memos) and NOT a code-level
-- coder comment (that is cb_coder_comments). It is anchored to ONE annotation —
-- a coder's highlighted transcript span (cb_annotations, char-anchored). Clicking
-- a highlight opens its comment thread, exactly like commenting on a Docs
-- selection. Commenting on arbitrary (not-yet-coded) text creates a kind='quote'
-- annotation as the anchor, then the first comment on it (client-side compose).
--
-- RLS design mirrors cb_annotations' read-all / write-own asymmetry, keyed on
-- author_id = auth.uid():
--   * SELECT is using(true) for `authenticated` -> every coder can READ all
--     comments on the session's visible annotations (a comment thread is shared
--     context, like a Docs comment everyone in the doc can see).
--   * INSERT / UPDATE / DELETE are gated on `author_id = auth.uid()` -> a coder
--     may only create/resolve/delete their OWN comments. A client authenticated
--     as user A CANNOT insert a row with author_id = <user B> (WITH CHECK fails).
--
-- `resolved` lets a thread be marked done (resolve / re-open) without deleting it.
-- `on delete cascade` on annotation_id: deleting the anchor annotation removes its
-- comment thread (the excerpt no longer exists to comment on).
--
-- Realtime: added to the supabase_realtime publication so a comment added in one
-- tab/device can surface in another (same read-all authorization as
-- cb_annotations; client narrows as needed). Cheap and additive.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table cb_annotation_comments (
  id uuid primary key default gen_random_uuid(),
  annotation_id uuid not null references cb_annotations(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  body text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index on cb_annotation_comments(annotation_id);
alter table cb_annotation_comments enable row level security;
create policy cb_ac_read on cb_annotation_comments for select to authenticated using (true);
create policy cb_ac_insert on cb_annotation_comments for insert to authenticated with check (author_id = auth.uid());
create policy cb_ac_update on cb_annotation_comments for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy cb_ac_delete on cb_annotation_comments for delete to authenticated using (author_id = auth.uid());

-- Optional (cheap): live-sync comments across the author's tabs/devices.
alter publication supabase_realtime add table cb_annotation_comments;

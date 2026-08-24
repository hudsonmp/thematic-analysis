-- 48_action_coding — (Applied 2026-08-21.) The ACTION-BASED coding layer:
-- a SEPARATE set of per-coder anchors whose "codes" are ACTIONS (moves ×
-- objects, migration 45) instead of codebook codes.
--
-- Why separate tables rather than a `layer` column on cb_annotations: the two
-- coding systems must stay isolated by construction — a legacy reader that
-- forgets a filter must NOT be able to surface an action-layer span as a
-- codebook annotation, and vice versa. So the action layer gets its own anchor
-- table (same anchor shape as cb_annotations so the player renders it with the
-- same machinery), its own comment table, its own per-coder status table, and a
-- junction that carries EITHER a reusable action id OR an ad hoc composition.
--
-- Shape:
--   * cb_action_annotations       — the anchor (session/version/segment/char
--                                   range/ms span/kind/coder), 1:1 with
--                                   cb_annotations' columns.
--   * cb_action_codings           — one coding on an anchor. `action_id` points
--                                   at a reusable cb_actions row (null for an ad
--                                   hoc, non-promoted combination). `move_ids`,
--                                   `object_ids`, `answers` SNAPSHOT the
--                                   composition in every case — the ad hoc form
--                                   needs them, and a linked coding keeps them as
--                                   a fallback should its action be deleted
--                                   (`on delete set null`) or edited later.
--                                   `answers` is jsonb: [{questionId, optionId,
--                                   freeText}].
--   * cb_action_annotation_comments — margin notes on an action-layer anchor.
--   * cb_action_coding_status     — per-coder progress for /coding/action
--                                   (absent row = not_started), independent of
--                                   cb_session_coding_status.
--
-- RLS mirrors cb_annotations / cb_annotation_comments / cb_session_coding_status
-- exactly: read-all to `authenticated`, write-own keyed on coder_id/author_id =
-- auth.uid(); codings inherit ownership transitively from their anchor.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table if not exists cb_action_annotations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cb_sessions(id) on delete cascade,
  version_id uuid not null references cb_transcript_versions(id) on delete cascade,
  segment_id uuid not null references cb_segments(id) on delete cascade,
  end_segment_id uuid references cb_segments(id) on delete cascade,
  char_start int not null default 0,
  char_end int not null default 0,
  quote_text text,
  prefix text,
  suffix text,
  t_start_ms int not null,
  t_end_ms int not null,
  anchor_status text not null default 'exact',
  kind text not null check (kind in ('code', 'quote', 'bookmark')),
  coder_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists cb_action_annotations_session_idx on cb_action_annotations (session_id);
create index if not exists cb_action_annotations_session_coder_idx on cb_action_annotations (session_id, coder_id);
create index if not exists cb_action_annotations_segment_idx on cb_action_annotations (segment_id);

create table if not exists cb_action_codings (
  id uuid primary key default gen_random_uuid(),
  annotation_id uuid not null references cb_action_annotations(id) on delete cascade,
  action_id uuid references cb_actions(id) on delete set null,
  move_ids uuid[] not null default '{}',
  object_ids uuid[] not null default '{}',
  answers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists cb_action_codings_annotation_idx on cb_action_codings (annotation_id);
create index if not exists cb_action_codings_action_idx on cb_action_codings (action_id);

create table if not exists cb_action_annotation_comments (
  id uuid primary key default gen_random_uuid(),
  annotation_id uuid not null references cb_action_annotations(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  body text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists cb_action_annotation_comments_annotation_idx on cb_action_annotation_comments (annotation_id);

create table if not exists cb_action_coding_status (
  session_id uuid not null references cb_sessions(id) on delete cascade,
  coder_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'in_progress' check (status in ('in_progress', 'individual_coding')),
  updated_at timestamptz not null default now(),
  primary key (session_id, coder_id)
);
create index if not exists cb_action_coding_status_coder_idx on cb_action_coding_status (coder_id);

alter table cb_action_annotations enable row level security;
alter table cb_action_codings enable row level security;
alter table cb_action_annotation_comments enable row level security;
alter table cb_action_coding_status enable row level security;

drop policy if exists cb_aann_read on cb_action_annotations;
create policy cb_aann_read on cb_action_annotations for select to authenticated using (true);
drop policy if exists cb_aann_insert on cb_action_annotations;
create policy cb_aann_insert on cb_action_annotations for insert to authenticated with check (coder_id = auth.uid());
drop policy if exists cb_aann_update on cb_action_annotations;
create policy cb_aann_update on cb_action_annotations for update to authenticated using (coder_id = auth.uid()) with check (coder_id = auth.uid());
drop policy if exists cb_aann_delete on cb_action_annotations;
create policy cb_aann_delete on cb_action_annotations for delete to authenticated using (coder_id = auth.uid());

drop policy if exists cb_acod_read on cb_action_codings;
create policy cb_acod_read on cb_action_codings for select to authenticated using (true);
drop policy if exists cb_acod_write on cb_action_codings;
create policy cb_acod_write on cb_action_codings for all to authenticated
  using (exists (select 1 from cb_action_annotations a where a.id = annotation_id and a.coder_id = auth.uid()))
  with check (exists (select 1 from cb_action_annotations a where a.id = annotation_id and a.coder_id = auth.uid()));

drop policy if exists cb_aac_read on cb_action_annotation_comments;
create policy cb_aac_read on cb_action_annotation_comments for select to authenticated using (true);
drop policy if exists cb_aac_insert on cb_action_annotation_comments;
create policy cb_aac_insert on cb_action_annotation_comments for insert to authenticated with check (author_id = auth.uid());
drop policy if exists cb_aac_update on cb_action_annotation_comments;
create policy cb_aac_update on cb_action_annotation_comments for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists cb_aac_delete on cb_action_annotation_comments;
create policy cb_aac_delete on cb_action_annotation_comments for delete to authenticated using (author_id = auth.uid());

drop policy if exists cb_acs_read on cb_action_coding_status;
create policy cb_acs_read on cb_action_coding_status for select to authenticated using (true);
drop policy if exists cb_acs_insert on cb_action_coding_status;
create policy cb_acs_insert on cb_action_coding_status for insert to authenticated with check (coder_id = auth.uid());
drop policy if exists cb_acs_update on cb_action_coding_status;
create policy cb_acs_update on cb_action_coding_status for update to authenticated using (coder_id = auth.uid()) with check (coder_id = auth.uid());
drop policy if exists cb_acs_delete on cb_action_coding_status;
create policy cb_acs_delete on cb_action_coding_status for delete to authenticated using (coder_id = auth.uid());

-- Live-sync own action-layer anchors/codings across the coder's tabs, like
-- cb_annotations / cb_annotation_codes.
alter publication supabase_realtime add table cb_action_annotations;
alter publication supabase_realtime add table cb_action_codings;

-- Migration 11_annotations
-- SP-A Task 8: cb_annotations + cb_annotation_codes with coder-owned RLS.
--
-- SUPERSEDES cb_codings: this annotation model replaces the old cb_codings table
-- as the unit of analysis (per-segment, per-coder spans with code links). cb_codings
-- is now DEAD: no longer written to or read from by the app. It is intentionally left
-- in place (not dropped) for data-safety; it can be dropped in a later cleanup migration.
--
-- RLS design (read-all / write-own asymmetry):
--   * SELECT is using(true) for `authenticated` -> everyone can read all annotations
--     (required for the Compare view and realtime sync across coders).
--   * INSERT / UPDATE / DELETE are gated on `coder_id = auth.uid()` -> a coder may
--     only create/modify/delete their OWN annotations. A client authenticated as user A
--     CANNOT insert a row with coder_id = <user B> (the WITH CHECK fails -> RLS rejects).
--   * cb_annotation_codes inherits ownership transitively: write is allowed only when
--     the parent annotation belongs to auth.uid().
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table cb_annotations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cb_sessions(id) on delete cascade,
  version_id uuid not null references cb_transcript_versions(id) on delete cascade,
  segment_id uuid not null references cb_segments(id) on delete cascade,
  char_start int not null default 0, char_end int not null default 0,
  quote_text text, prefix text, suffix text,
  t_start_ms int not null, t_end_ms int not null,
  anchor_status text not null default 'exact',
  kind text not null check (kind in ('code','quote')),
  coder_id uuid not null references auth.users(id),
  is_canonical boolean not null default false,
  created_at timestamptz not null default now()
);

create table cb_annotation_codes (
  annotation_id uuid not null references cb_annotations(id) on delete cascade,
  code_id uuid not null references cb_codes(id) on delete cascade,
  primary key (annotation_id, code_id)
);

create index on cb_annotations(session_id);
create index on cb_annotations(session_id, coder_id);
create index on cb_annotations(segment_id);
create index on cb_annotation_codes(annotation_id);

alter table cb_annotations enable row level security;
alter table cb_annotation_codes enable row level security;

-- Read-all (Compare/realtime), write-own (coder ownership).
create policy cb_ann_read on cb_annotations for select to authenticated using (true);
create policy cb_ann_insert on cb_annotations for insert to authenticated with check (coder_id = auth.uid());
create policy cb_ann_update on cb_annotations for update to authenticated using (coder_id = auth.uid()) with check (coder_id = auth.uid());
create policy cb_ann_delete on cb_annotations for delete to authenticated using (coder_id = auth.uid());

create policy cb_annc_read on cb_annotation_codes for select to authenticated using (true);
create policy cb_annc_write on cb_annotation_codes for all to authenticated
  using (exists (select 1 from cb_annotations a where a.id = annotation_id and a.coder_id = auth.uid()))
  with check (exists (select 1 from cb_annotations a where a.id = annotation_id and a.coder_id = auth.uid()));

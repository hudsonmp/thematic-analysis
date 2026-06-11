-- 10_sessions.sql
-- Cloud-sessions schema + private Storage bucket for the thematic-analysis tool.
-- Additive cb_/storage only. Does NOT touch study tables.

-- ── Tables ───────────────────────────────────────────────────────────────────

create table cb_sessions (
  id uuid primary key default gen_random_uuid(),
  pid_label text not null,
  collection text not null default 'uncategorized',
  track_mode text not null default 'single' check (track_mode in ('single','multi')),
  video_path text, audio_path text, srt_path text,
  recording_started_at timestamptz, duration_ms int,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table cb_transcript_versions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cb_sessions(id) on delete cascade,
  kind text not null check (kind in ('original','cleaned')),
  asr_engine text, is_verbatim boolean not null default true,
  derived_from_version_id uuid references cb_transcript_versions(id),
  created_at timestamptz not null default now(),
  unique (session_id, kind)
);

create table cb_segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cb_sessions(id) on delete cascade,
  version_id uuid not null references cb_transcript_versions(id) on delete cascade,
  speaker text, track_index int,
  t_start_ms int not null, t_end_ms int not null,
  text text not null, words jsonb,
  ordinal int not null,
  source text not null default 'acoustic' check (source in ('acoustic','resegmented','manual')),
  created_at timestamptz not null default now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

create index on cb_transcript_versions(session_id);
create index on cb_segments(session_id, version_id, ordinal);
create index on cb_segments(session_id, t_start_ms);

-- ── RLS (authenticated researchers) ──────────────────────────────────────────

alter table cb_sessions enable row level security;
alter table cb_transcript_versions enable row level security;
alter table cb_segments enable row level security;

create policy cb_sessions_read on cb_sessions for select to authenticated using (true);
create policy cb_sessions_write on cb_sessions for all to authenticated using (true) with check (true);
create policy cb_tv_read on cb_transcript_versions for select to authenticated using (true);
create policy cb_tv_write on cb_transcript_versions for all to authenticated using (true) with check (true);
create policy cb_seg_read on cb_segments for select to authenticated using (true);
create policy cb_seg_write on cb_segments for all to authenticated using (true) with check (true);

-- ── Private Storage bucket ───────────────────────────────────────────────────

insert into storage.buckets (id, name, public) values ('recordings','recordings',false)
  on conflict (id) do nothing;

-- RLS on storage.objects: authenticated researchers may read/write objects in the
-- 'recordings' bucket. storage.objects already has RLS enabled by default — do NOT re-enable.
drop policy if exists "recordings_auth_read" on storage.objects;
drop policy if exists "recordings_auth_insert" on storage.objects;
drop policy if exists "recordings_auth_update" on storage.objects;
drop policy if exists "recordings_auth_delete" on storage.objects;

create policy "recordings_auth_read" on storage.objects for select to authenticated using (bucket_id = 'recordings');
create policy "recordings_auth_insert" on storage.objects for insert to authenticated with check (bucket_id = 'recordings');
create policy "recordings_auth_update" on storage.objects for update to authenticated using (bucket_id = 'recordings');
create policy "recordings_auth_delete" on storage.objects for delete to authenticated using (bucket_id = 'recordings');

-- 12_drive_video — store session video in Google Drive instead of Supabase
-- Storage (sidesteps the free-plan 50MB single-upload cap). Audio, transcript,
-- and codings stay in Supabase; only the large video moves to Drive.
--
--   drive_file_id  the Drive file id for the video (null when video_source =
--                  'supabase' or there is no video).
--   video_source   which backend serves this session's video. Defaults to
--                  'supabase' so every pre-existing row keeps its current
--                  signed-URL streaming behaviour with no backfill.
--
-- The media route reads video_source to decide between a Drive Range-proxy and
-- the existing Supabase signed-URL 302.

alter table cb_sessions add column drive_file_id text;
alter table cb_sessions add column video_source text not null default 'supabase' check (video_source in ('supabase','drive'));

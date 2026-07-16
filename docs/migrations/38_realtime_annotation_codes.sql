-- 38_realtime_annotation_codes.sql
-- (Applied 2026-07-15.) addCodeToAnnotation / removeCodeFromAnnotation write ONLY the
-- junction (cb_annotation_codes), so realtime must publish it or a second tab's
-- chips/braces go stale until an unrelated cb_annotations event fires. SELECT RLS on
-- the junction is already read-all, so publication needs no policy change. cb_ only.
alter publication supabase_realtime add table cb_annotation_codes;

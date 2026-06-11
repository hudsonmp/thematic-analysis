-- 17_drop_cb_codings.sql
--
-- Drop the dead `cb_codings` table. It was the original time-anchored coding
-- store written from the session player, superseded by the annotation model:
--   cb_annotations       -- the anchor row (segment_id + char range + ms span)
--   cb_annotation_codes  -- one (annotation_id, code_id) link per code applied
--
-- By the time of this migration `cb_codings` held 0 rows and was referenced by
-- no live code path (its only consumer, app/actions/codings.ts, is removed in
-- the same change; the live player uses app/actions/annotations.ts). Dropping it
-- also clears its `rls_enabled_no_policy` advisor warning (RLS was enabled on the
-- table but it had no policies).

drop table if exists cb_codings;

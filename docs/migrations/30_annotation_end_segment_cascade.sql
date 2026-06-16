-- 30_annotation_end_segment_cascade.sql
-- Make the multi-cue `end_segment_id` anchor cascade on segment delete.
--
-- Migration 29 added `end_segment_id uuid references cb_segments(id)` with the
-- DEFAULT delete rule (NO ACTION). The primary anchor `segment_id` is ON DELETE
-- CASCADE, so deleting a cue deletes any annotation anchored to it. The range END
-- should behave identically: an annotation can't survive losing EITHER of its two
-- anchor cues, so both anchors must cascade.
--
-- Why this matters for session deletion: deleting a `cb_sessions` row cascades to
-- its `cb_segments` (session_id CASCADE) AND its `cb_annotations` (session_id
-- CASCADE). With `end_segment_id` left at NO ACTION, the constraint is only
-- satisfied because the referencing annotations happen to be removed by the
-- session_id cascade before the end-of-statement check — correct today, but
-- dependent on cascade ordering. ON DELETE CASCADE makes the end anchor remove its
-- annotation directly, matching `segment_id` and removing the fragility.
--
-- Idempotent: drop the existing FK (by its known auto-generated name) and re-add it
-- with the cascade rule.

alter table cb_annotations
  drop constraint if exists cb_annotations_end_segment_id_fkey;

alter table cb_annotations
  add constraint cb_annotations_end_segment_id_fkey
  foreign key (end_segment_id) references cb_segments(id) on delete cascade;

-- 29_annotation_end_segment.sql
-- Multi-CUE (cross-segment) text-selection anchoring.
--
-- The SP-A anchor model was single-segment: an annotation stored ONE `segment_id`
-- with `char_start`/`char_end` offsets WITHIN that segment's text. With speaker-turn
-- grouping a transcript reads as flowing paragraphs, so researchers naturally select
-- a phrase that spans several cues — which the single-segment model rejected.
--
-- This adds a RANGE end: `segment_id` + `char_start` is the START of the selection,
-- `end_segment_id` + `char_end` is the END. The covered cues are those with ordinal
-- BETWEEN the two (the start cue highlighted from char_start to its end, middle cues
-- whole, the end cue from 0 to char_end). `end_segment_id` is NULL for a
-- single-segment annotation (char_end is then an offset within `segment_id`), so every
-- existing row stays valid with no backfill — the player's render path treats a NULL
-- (or self-referential) end as the original single-segment case.
--
-- One annotation row still represents one selection, so comments / codes / deletes
-- (all keyed on `annotation_id`) are unchanged.

alter table cb_annotations
  add column if not exists end_segment_id uuid references cb_segments(id);

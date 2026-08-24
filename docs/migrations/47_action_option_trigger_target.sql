-- 47_action_option_trigger_target — (Applied 2026-08-20.) A multiple-choice
-- option's "then →" TRIGGER may now point at an ACTION, an OBJECT, or a MOVE,
-- not only an action. The vocabularies are authored in parallel with the
-- questions, so the lists may well be empty when a question is written; the
-- trigger is a pointer into whichever layer the researcher wants the coder to
-- reach for next.
--
-- Modelled as three nullable FKs (not a polymorphic kind+id pair) so the
-- database keeps referential integrity and `on delete set null` semantics for
-- every target kind. At most ONE may be set — an option triggers one thing.
-- Existing trigger_action_id rows are untouched.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

alter table cb_action_question_options
  add column if not exists trigger_object_id uuid references cb_action_objects(id) on delete set null;

alter table cb_action_question_options
  add column if not exists trigger_move_id uuid references cb_action_moves(id) on delete set null;

alter table cb_action_question_options
  drop constraint if exists cb_action_question_options_one_trigger;
alter table cb_action_question_options
  add constraint cb_action_question_options_one_trigger check (
    (case when trigger_action_id is not null then 1 else 0 end)
    + (case when trigger_object_id is not null then 1 else 0 end)
    + (case when trigger_move_id   is not null then 1 else 0 end) <= 1
  );

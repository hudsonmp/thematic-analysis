-- Migration 31_observation_retro_question
-- Live researcher → participant: QUEUE a custom RETROSPECTIVE QUESTION.
--
-- An observation could be a FLAG (flag_type_id), an EVENT-MARK (episode_id), a
-- NOTE (body), and/or a QUOTE (is_quote). This adds a fifth kind: a RETRO-QUESTION
-- — a custom retrospective question the researcher composes on /live for a SPECIFIC
-- scenario, broadcasts live to the participant (consumed at that scenario's retro
-- step), AND persists here so the coding tool can later surface "the question that
-- was asked".
--
-- DISCRIMINATOR (no new kind column): a retro-question row is exactly a row whose
-- `retro_question_scenario_idx IS NOT NULL`. The 0-based target scenario index goes
-- in this column; the QUESTION TEXT reuses the existing `body`. So a retro-question
-- row has body = the question, retro_question_scenario_idx = the scenario, and
-- (typically) no flag/episode/quote. A NULL here means "this row is not a
-- retro-question" — every pre-existing observation reads as NULL, so the column is
-- purely additive and backfill-free.
--
-- The scenario index is stored as a plain integer (NOT a cb_episodes FK): it keys
-- the AUTHORED study's 0-based scenario position (`scenario_<idx>_…`), the same
-- index the cross-repo broadcast payload carries — not a taxonomy row. It is left
-- unconstrained-by-range here (a finite-but-out-of-range idx simply never matches a
-- real scenario downstream); the server action is the single write path.
--
-- Additive cb_ only, nullable, no default → safe online. Does NOT touch
-- study/onboarding/users tables.

alter table cb_observations
  add column retro_question_scenario_idx integer;

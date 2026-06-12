-- Migration 26_observation_quote
-- Live co-observation: QUOTE marks — a one-tap red-ribbon bookmark of a quotable
-- moment.
--
-- An observation was a FLAG (flag_type_id), an EVENT-MARK (episode_id), and/or a
-- NOTE (body). This adds a fourth, content-free kind: a QUOTE — a tap that pins
-- ONLY the current live moment (is_quote = true) so a researcher can grab the
-- exact words later from the recording at that timestamp. No flag, no episode, no
-- body is required: the timestamp is the whole point.
--
-- So an observation now needs AT LEAST ONE of (flag_type_id, episode_id, body,
-- is_quote=true) to carry information; the server action enforces this. A row with
-- all of (flag, episode, body) null AND is_quote=false carries no information and
-- is rejected by the action.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

alter table cb_observations
  add column is_quote boolean not null default false;

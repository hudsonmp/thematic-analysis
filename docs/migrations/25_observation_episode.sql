-- Migration 25_observation_episode
-- Live co-observation: MARK EVENTS live (parallel to flags).
--
-- An observation was a FLAG (flag_type_id) and/or a NOTE (body). This adds a third
-- kind: an EVENT-MARK — a tap that pins a preset EPISODE (cb_episodes — e.g.
-- "Read", "Revise") at the current live moment, exactly the way a flag tap pins a
-- flag type. So an observation is now a flag, an event-mark, a note, or any
-- combination — at least one of (flag_type_id, episode_id, body) must be present
-- (the server action enforces "at least one"; the both/all-null observation
-- carries no information and is rejected).
--
-- episode_id is nullable and ON DELETE SET NULL: a bare flag/note has no episode;
-- a preset episode deleted from the taxonomy leaves its event-marks intact (the
-- join then reads as a deleted-episode sentinel), mirroring flag_type_id's
-- set-null semantics. At upload, observations carrying episode_id materialize into
-- cb_session_episodes at (created_at - recording_started_at), so live phase-marks
-- land on the review timeline beside the auto-derived ones.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

alter table cb_observations
  add column episode_id uuid references cb_episodes(id) on delete set null;
create index on cb_observations(episode_id);

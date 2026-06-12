-- 28_session_episode_unique.sql
-- Idempotency for auto-derived session-episode marks (Task 2/5 follow-up).
--
-- materializeAutoEpisodes now runs AUTOMATICALLY on every session page load. Its
-- "skip if the (session_id, episode_id, t_start_ms) triple already exists" guard
-- was pure application code (read-then-insert), which RACES under concurrent or
-- repeated loads and duplicated every mark (observed: 6x). The real fix is a DB
-- UNIQUE constraint so a colliding triple is impossible regardless of concurrency;
-- the action's inserts become upserts with ignoreDuplicates.
--
-- Step 1 dedupes any pre-existing duplicate triples (required before the
-- constraint can be added). Step 2 adds the constraint.

-- 1. Collapse duplicate triples, keeping one physical row per triple.
delete from cb_session_episodes a
using cb_session_episodes b
where a.session_id = b.session_id
  and a.episode_id = b.episode_id
  and a.t_start_ms = b.t_start_ms
  and a.ctid > b.ctid;

-- 2. Enforce one mark per (session, episode, start-offset).
alter table cb_session_episodes
  add constraint cb_session_episodes_session_episode_tstart_key
  unique (session_id, episode_id, t_start_ms);

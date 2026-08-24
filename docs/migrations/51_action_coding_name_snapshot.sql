-- 51_action_coding_name_snapshot — pin the ACTION NAME at coding time.
--
-- Migration 48 already snapshots a coding's composition (move_ids, object_ids,
-- answers; object_roles arrived in 50) but NOT the name of the action it was
-- entered through. The read path then resolved the name live from cb_actions,
-- so `updateAction` — which runs on the service-role client, bypassing RLS,
-- gated only by requireEditor() — silently rewrote the label on every coder's
-- existing codings, with no audit trail.
--
-- With the composition pinned to the snapshot (lib/actions/projection.ts) the
-- name is the last live read-through, so it gets a snapshot column too. A
-- coding now renders exactly what its coder attached; divergence from the
-- current vocabulary is REPORTED as drift, never applied.
--
-- Nullable on purpose: an ad hoc coding points at no action and carries no
-- name. The backfill is a no-op on an empty table (0 codings at write time)
-- and correct if any exist.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

alter table cb_action_codings add column if not exists action_name text;

update cb_action_codings c
set action_name = a.name
from cb_actions a
where c.action_id = a.id
  and c.action_name is null;

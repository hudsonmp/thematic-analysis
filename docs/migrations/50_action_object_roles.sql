-- 50_action_object_roles — (Applied 2026-08-21.) Assign a ROLE (migration 49's
-- vocabulary) to each OBJECT inside an action. Roles are OPTIONAL: a Trace may
-- name its two objects "source" / "target", a Create usually names none.
--
-- Two places hold the object↔role pairing, mirroring how the composition
-- itself is stored:
--   * cb_action_objects_link.role_id — the reusable action's roles (one role per
--                                      object per action; the link row IS the
--                                      object slot). `set null` on delete so
--                                      removing a role from the vocabulary never
--                                      deletes an object from an action.
--   * cb_action_codings.object_roles — jsonb SNAPSHOT {objectId: roleId} for a
--                                      coding, like move_ids / object_ids: the ad
--                                      hoc (non-promoted) form needs it, and a
--                                      linked coding keeps it as a fallback.
--
-- Roles are part of the composition for duplicate matching: Trace(Entity:source,
-- Scenario:target) and Trace(Entity:target, Scenario:source) are two actions.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

alter table cb_action_objects_link
  add column if not exists role_id uuid references cb_action_roles(id) on delete set null;

alter table cb_action_codings
  add column if not exists object_roles jsonb not null default '{}'::jsonb;

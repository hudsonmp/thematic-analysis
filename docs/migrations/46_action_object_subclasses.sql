-- 46_action_object_subclasses — (Applied 2026-08-20.) Objects may have
-- SUBCLASSES: one level of `parent_id` on cb_action_objects. A subclass is a
-- full object (it can be linked to actions and counts toward a move's
-- min_objects on its own); the parent only groups and labels it.
--
-- Depth is one level — enforced in app/actions/action-schema.ts (a parent must
-- itself be top-level, and an object that has children cannot be re-parented).
-- `on delete set null`: deleting a parent PROMOTES its subclasses to top level
-- rather than deleting them, so no action's object links are silently lost.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

alter table cb_action_objects
  add column if not exists parent_id uuid references cb_action_objects(id) on delete set null;

alter table cb_action_objects
  drop constraint if exists cb_action_objects_parent_not_self;
alter table cb_action_objects
  add constraint cb_action_objects_parent_not_self check (parent_id is null or parent_id <> id);

create index if not exists cb_action_objects_parent_idx on cb_action_objects (parent_id, position);

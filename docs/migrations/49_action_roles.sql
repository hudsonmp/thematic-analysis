-- 49_action_roles — (Applied 2026-08-21.) The ROLE vocabulary: the researcher
-- lists, as plain bullet points, every role that may later be assigned to an
-- OBJECT inside an action (e.g. "source" / "target" of a Trace, "parent" /
-- "child" of a Revise). This migration only defines the list — the object↔role
-- assignment itself is a later step and touches nothing here.
--
-- Shape (codebook-scoped, same as cb_action_moves):
--   * cb_action_roles — name + optional description, ordered by `position`.
--
-- RLS: read-all to `authenticated`; NO write policies — writes go through the
-- service-role client behind requireEditor() in app/actions/action-schema.ts.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table if not exists cb_action_roles (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  name text not null,
  description text,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists cb_action_roles_codebook_idx on cb_action_roles (codebook_id, position);

alter table cb_action_roles enable row level security;

drop policy if exists cb_action_roles_read on cb_action_roles;
create policy cb_action_roles_read on cb_action_roles for select to authenticated using (true);

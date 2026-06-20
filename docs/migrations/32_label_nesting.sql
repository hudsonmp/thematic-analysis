-- 32_label_nesting.sql
-- NESTED LABELS: make the codebook-scoped label vocabulary (cb_labels, migration
-- 20) hierarchical. Adds a self-referential `parent_id` so a label can sit under
-- another label to arbitrary depth (adjacency list, no hard cap) — e.g.
-- "Scientific Reasoning -> Experimentation -> Hypothesizing". `position` keeps
-- ordering CODES the same way it always has, now interpreted within a sibling
-- group (siblings sharing `parent_id`) rather than codebook-global.
--
-- `on delete set null` is the DB-level SAFETY NET only: the application
-- `deleteLabel` action PROMOTES a deleted label's children to its own parent
-- before deleting, so a removed folder collapses up one level instead of
-- orphaning children to root. The index speeds the (codebook_id, parent_id)
-- sibling-group lookups the folder-tree fold relies on.
--
-- Additive + nullable -> backward-compatible. Touches only cb_labels; does NOT
-- touch study/onboarding/users tables, nor episodes/events, facets, flags, or
-- observations.
alter table cb_labels add column if not exists parent_id uuid references cb_labels(id) on delete set null;
create index if not exists cb_labels_parent_idx on cb_labels(codebook_id, parent_id);

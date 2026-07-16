-- 36_labels_to_facets.sql
-- ONE GROUPING MECHANISM. Fold the label tree into facets and stop using cb_labels.
--
-- WHY. The codebook had two ways to group codes and no principle deciding between
-- them: cb_labels (an arbitrary construct tree, many-to-many) and cb_facets
-- (dimensions). Every new grouping forced an unprincipled "tree or facet?" call, and
-- a code that cross-cuts two branches — "confirmation bias while reviewing a
-- hypothesis against an experiment" — could only be expressed by DUPLICATING it into
-- both branches, which records two memberships and loses the fact that it is ONE
-- phenomenon. A hierarchy encodes exactly one dimension; the moment a second
-- independent dimension exists it must ENUMERATE the cross-product (k^N leaves) where
-- a facet scheme FACTORS it (N*k labels). So: facets are primary, and the tree lives
-- INSIDE a facet as its nested value chain (migration 35).
--
-- THE MIGRATION RULE, general — no codebook-specific values are invented here:
--
--     each ROOT label            -> a FACET   (the question)
--     each of its DESCENDANTS    -> a VALUE of that facet, nesting preserved
--     each cb_code_labels row    -> a cb_code_facet_values row
--
-- The root is the question and its subtree is the answer space, so a tree like
-- `Exploration -> {Hypothesis Space, Experiment Space}` becomes the facet
-- "Exploration" with those two values. Nothing is hand-mapped.
--
-- Facets are created with cardinality 'multi' because a code may legitimately carry
-- two values on one dimension (that is the cross-cutting case, now expressible
-- WITHOUT duplication) and type 'enum' because only enum facets have values.
--
-- IDEMPOTENT + REVERSIBLE. `cb_facet_values.key` is set to the SOURCE LABEL'S UUID,
-- which (a) guarantees uniqueness within the facet, (b) gives a stable join for the
-- parent and membership passes, and (c) leaves a permanent breadcrumb back to the
-- row each value came from. cb_labels and cb_code_labels are NOT dropped — the data
-- is copied, not moved, so a bad migration is undone by ignoring the new facets
-- rather than by restoring a backup. Dropping them is a later, separate decision.
--
-- ALSO: delete the valueless open_text/boolean facets. They were never dimensions —
-- a facet with no values partitions nothing, cannot be filtered, cross-tabbed, or
-- lensed. They were being used as per-code FORM FIELDS, duplicating columns that
-- already exist and are versioned on cb_code_versions (definition, include_if,
-- exclude_if, exemplars). Two homes for include_if with nothing syncing them is a
-- drift bug waiting to happen. After this, cb_facets means exactly ONE thing: a
-- classification dimension.
--
-- cb_ tables only. Does NOT touch study/onboarding/users tables.

-- 1. Drop the valueless pseudo-facets (form fields, not dimensions). Their per-code
--    data in cb_code_facet_fields cascades with them.
delete from cb_facets f
where f.type in ('open_text', 'boolean')
  and not exists (select 1 from cb_facet_values v where v.facet_id = f.id);

-- 2. Every ROOT label becomes a facet of its codebook.
insert into cb_facets (codebook_id, key, label, description, cardinality, type, position)
select
  l.codebook_id,
  l.id::text,                                   -- key = source label uuid (stable join + breadcrumb)
  l.name,
  l.note,
  'multi',                                      -- a code may carry two values on one dimension
  'enum',                                       -- only enum facets have values
  coalesce((select max(f2.position) + 1 from cb_facets f2 where f2.codebook_id = l.codebook_id), 0) + l.position
from cb_labels l
where l.parent_id is null
  and not exists (select 1 from cb_facets f where f.codebook_id = l.codebook_id and f.key = l.id::text);

-- 3. Every NON-root label becomes a VALUE of the facet made from its root ancestor.
--    The recursive walk climbs each label to its root, so depth is unbounded.
with recursive rooted as (
  select l.id, l.codebook_id, l.name, l.note, l.color, l.position, l.parent_id, l.id as root_id
  from cb_labels l
  where l.parent_id is null
  union all
  select c.id, c.codebook_id, c.name, c.note, c.color, c.position, c.parent_id, r.root_id
  from cb_labels c
  join rooted r on c.parent_id = r.id
)
insert into cb_facet_values (facet_id, key, label, description, color, position)
select f.id, r.id::text, r.name, r.note, r.color, r.position
from rooted r
join cb_facets f on f.codebook_id = r.codebook_id and f.key = r.root_id::text
where r.parent_id is not null                   -- roots became the FACET, not a value
  and not exists (select 1 from cb_facet_values v where v.facet_id = f.id and v.key = r.id::text);

-- 4. Re-hang the value nesting. A value's parent is the value made from the label's
--    parent — UNLESS that parent was the root (which became the facet itself), in
--    which case the value stays top-level within the facet.
update cb_facet_values v
set parent_id = pv.id
from cb_labels l
join cb_labels lp on lp.id = l.parent_id
join cb_facet_values pv on pv.key = lp.id::text
where v.key = l.id::text
  and pv.facet_id = v.facet_id
  and v.parent_id is null;

-- 5. Code memberships: (code, label) -> (code, facet_value).
insert into cb_code_facet_values (code_id, facet_value_id)
select cl.code_id, v.id
from cb_code_labels cl
join cb_facet_values v on v.key = cl.label_id::text
on conflict do nothing;

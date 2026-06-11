-- 21_citation_role_related.sql
--
-- Widen the cb_code_citations.role CHECK to admit 'related', the role used when
-- a citation is HAND-LINKED to a code via the new built-in "Citations" facet
-- (Scheme page → code Classification). This distinguishes a manual link from the
-- deductive-coding flow's 'derived_from' (code authored FROM a paper) and from
-- 'near_miss' (a paper that almost matched). All three roles count equally as
-- "linked": the Citations facet reflects EVERY cb_code_citations row regardless
-- of role.
--
-- Pure superset widening: the prior check was role IN ('derived_from','near_miss');
-- this only ADDS 'related', so no existing row can be invalidated (and at apply
-- time the table held zero rows). Additive, non-breaking, no data migration.
alter table cb_code_citations
  drop constraint if exists cb_code_citations_role_check;

alter table cb_code_citations
  add constraint cb_code_citations_role_check
  check (role in ('derived_from', 'near_miss', 'related'));

-- 05_fix_comment_version_fk
--
-- Defect: cb_coder_comments had a composite FK
--   (code_id, code_version) references cb_code_versions(code_id, version) on delete set null
-- but code_id is declared NOT NULL. ON DELETE SET NULL nulls ALL referencing columns, so
-- deleting a referenced cb_code_versions row would attempt to null BOTH code_id and
-- code_version, violating the code_id NOT NULL constraint -- erroring instead of nulling.
--
-- The composite FK is over-specified for comments: code versions are append-only, so there
-- is no need for a referential constraint tying a comment to a specific version row.
-- code_version becomes a plain nullable int with no referential constraint.
--
-- The single-column FK code_id -> cb_codes(id) ON DELETE CASCADE remains and is correct.
-- (cb_codings keeps its analogous composite FK because it uses ON DELETE RESTRICT, which is fine.)

alter table cb_coder_comments drop constraint cb_coder_comments_code_id_code_version_fkey;

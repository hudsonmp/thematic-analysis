-- 06_codebook_unique_study
--
-- Makes the idempotent study->codebook bind in getOrCreateCodebook() a real
-- guarantee instead of a check-then-insert convention. Without a DB constraint,
-- two concurrent callers can both pass the "does a codebook for this study
-- exist?" read and both insert, producing duplicate codebooks for one study.
--
-- study_id is nullable, and Postgres treats NULLs as distinct in a UNIQUE
-- index, so multiple study-less codebooks remain allowed; this only enforces
-- AT MOST ONE codebook per non-null study_id -- exactly the bind we rely on.
--
-- Safe to apply: there is currently a single cb_codebooks row, so no conflict.

alter table cb_codebooks add constraint cb_codebooks_study_id_unique unique (study_id);

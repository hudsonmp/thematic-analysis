-- 07_reliability_degenerate
--
-- Persist the `degenerate` flag computed by computeReliability() as a real
-- column instead of only encoding it in the free-text `note`. A run is
-- degenerate when the label set has a single distinct category: Cohen's kappa
-- returns 1 (Pe=1) which would otherwise read as "perfect agreement" rather
-- than the truth ("undefined / uninformative"). The reliability panel needs to
-- detect single-category runs structurally, without parsing the note string.
--
-- NOT NULL DEFAULT false: every prior run was a real (non-degenerate) compute,
-- so backfilling existing rows to false is correct, and new inserts that omit
-- the column stay safe.

alter table cb_reliability_runs add column degenerate boolean not null default false;

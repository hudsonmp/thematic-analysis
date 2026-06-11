-- Migration 13_realtime
-- SP-A Task 10: live sync of a coder's OWN annotations across their devices/tabs.
--
-- Supabase Realtime streams Postgres changes only for tables that are members of
-- the `supabase_realtime` publication. Task 10's `useRealtimeAnnotations` hook
-- subscribes (with `postgres_changes`) to:
--   * cb_annotations — INSERT/UPDATE/DELETE, filtered to session_id; the hook
--     acts only on rows whose coder_id == the signed-in user (own-coding
--     isolation: other coders' in-progress work never surfaces in the rail).
--   * cb_codes       — INSERT/UPDATE, so the code picker refreshes when the
--     codebook changes (optional, cheap).
--
-- RLS authorization: Realtime authorizes each subscriber against the table's RLS
-- SELECT policy using the JWT the browser client carries (the @supabase/ssr
-- browser client hydrates the session from cookies). cb_annotations' SELECT
-- policy is `using(true)` for `authenticated`, so the stream is authorized; the
-- hook does the own-row narrowing client-side. No RLS change is needed here.
--
-- DELETE payloads: with the default replica identity (PRIMARY KEY), a DELETE
-- change carries only the PK under `old`. That is exactly what the hook needs —
-- it removes by `old.id`. No `replica identity full` is required.
--
-- Additive only: this migration changes ONLY publication membership. It does not
-- touch table schemas, RLS, or any study/onboarding/users tables.

alter publication supabase_realtime add table cb_annotations;
alter publication supabase_realtime add table cb_codes;

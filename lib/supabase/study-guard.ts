import 'server-only';
import { createUserServerClient } from '@/lib/supabase/user-server';
import {
  assertStudyTable,
  selectOnly,
  type StudyTable,
} from '@/lib/supabase/study-guard-core';

export { STUDY_TABLES, assertStudyTable } from '@/lib/supabase/study-guard-core';
export type { StudyTable } from '@/lib/supabase/study-guard-core';

/**
 * Use for ALL study-data READS. Returns a SELECT-ONLY query builder on `table`:
 *
 *  - CREDENTIAL: the anon-key USER client (researcher JWT). Since migration
 *    `study_tables_researcher_readonly_rls` (applied 2026-07-01), every study
 *    table carries a SELECT-only RLS policy for `authenticated` and NO write
 *    policy — so even bypassing this wrapper, Postgres refuses writes on this
 *    credential. The service-role key no longer touches study tables at all.
 *  - COMPILE TIME: `T extends StudyTable` (closed allowlist union).
 *  - RUNTIME: `assertStudyTable` + a Proxy that throws on any write-verb access.
 *
 * Mirrors `cbFrom` (guard.ts), which remains the ONLY write path (cb_ tables,
 * service role). See the write-safety spec, layer L2.
 */
export async function studyFrom<T extends StudyTable>(table: T) {
  assertStudyTable(table);
  const sb = await createUserServerClient();
  const builder = sb.from(table);
  return selectOnly(builder);
}

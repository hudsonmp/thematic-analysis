import 'server-only';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { assertEvalTable, type EvalTable } from '@/lib/supabase/eval-guard-core';

export { EVAL_TABLES, assertEvalTable } from '@/lib/supabase/eval-guard-core';
export type { EvalTable } from '@/lib/supabase/eval-guard-core';

/**
 * Use for ALL eval-harness data access. Returns the FULL query builder on
 * `table` — reads AND writes — because eval_* tables are the harness's own
 * storage (safety spec L5), not participant data:
 *
 *  - CREDENTIAL: the anon-key USER client (researcher JWT). RLS grants the
 *    researcher full access on eval_* tables; the service-role key stays
 *    quarantined to cbFrom and never touches this path.
 *  - COMPILE TIME: `T extends EvalTable` (closed allowlist union).
 *  - RUNTIME: `assertEvalTable`, so a typo'd or computed table name can never
 *    reach cb_/study_ data through this helper.
 *
 * Differs from `studyFrom` (SELECT-only proxy — IRB data) in exactly one way:
 * no write-verb guard, because writing eval data is the point.
 */
export async function evalFrom<T extends EvalTable>(table: T) {
  assertEvalTable(table);
  const sb = await createUserServerClient();
  return sb.from(table);
}

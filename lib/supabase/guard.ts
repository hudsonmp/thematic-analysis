import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertCbTable } from '@/lib/supabase/guard-core';
import type { Database } from '@/lib/types/cb-db';

export { assertCbTable };

/** All `cb_`-prefixed table names from the generated schema. */
type CbTable = Extract<keyof Database['public']['Tables'], `cb_${string}`>;

/** Use for ALL codebook writes. The `CbTable` bound enforces the `cb_` prefix at
 *  compile time; `assertCbTable` is the matching runtime guard (service-role key
 *  bypasses RLS, so study data must never be reachable through this helper). */
export function cbFrom(table: CbTable) {
  assertCbTable(table);
  return createServiceRoleClient().from(table);
}

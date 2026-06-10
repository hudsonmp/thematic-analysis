import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertCbTable } from '@/lib/supabase/guard-core';
import type { Database } from '@/lib/types/cb-db';

export { assertCbTable };

/** All `cb_`-prefixed table names from the generated schema. */
type CbTable = Extract<keyof Database['public']['Tables'], `cb_${string}`>;

/** Use for ALL codebook writes. The `CbTable` bound enforces the `cb_` prefix at
 *  compile time; `assertCbTable` is the matching runtime guard (service-role key
 *  bypasses RLS, so study data must never be reachable through this helper).
 *
 *  Generic over the literal table name `T` so the returned query builder is bound
 *  to that single table's Row/Insert/Update types. Without the generic, `table`'s
 *  type is the union of every cb_ table and the client widens all columns to
 *  `never`, making concrete `.insert()/.update()` payloads untypable at call sites. */
export function cbFrom<T extends CbTable>(table: T) {
  assertCbTable(table);
  return createServiceRoleClient().from(table);
}

// Guard scope: `cbFrom` covers `.from()` writes only (compile-time `CbTable`
// bound + runtime `assertCbTable` prefix check). It does NOT intercept
// `.rpc()` calls to study stored procedures or dynamic/computed table names —
// those are caught only by code review + `scripts/check-no-study-writes.sh`
// (in `npm run lint`) and the post-test DB verification. See guard-core.ts.

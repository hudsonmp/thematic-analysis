import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertCbTable } from '@/lib/supabase/guard-core';

export { assertCbTable };

/** Use for ALL codebook writes. */
export function cbFrom(table: string) {
  assertCbTable(table);
  return createServiceRoleClient().from(table);
}

import 'server-only';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/cb-db';

export function createServiceRoleClient() {
  return createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

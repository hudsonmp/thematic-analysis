import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createUserServerClient } from '@/lib/supabase/user-server';

/**
 * PER-REQUEST MEMOIZED (React cache): `auth.getUser()` is a NETWORK round trip
 * to Supabase Auth, and a typical mutating action used to pay it twice or more
 * (its own requireAuthUser + requireEditor → getMyRole → requireAuthUser).
 * With the memo, any number of stacked gates in one action invocation costs
 * exactly one auth call. Safety is unchanged: this is the same verified-user
 * result the duplicate calls returned.
 */
export const getAuthUser = cache(async () => {
  const sb = await createUserServerClient();
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
});

export async function requireAuthUser() {
  const u = await getAuthUser();
  if (!u) redirect('/create/login');
  return u;
}

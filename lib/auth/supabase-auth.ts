import 'server-only';
import { redirect } from 'next/navigation';
import { createUserServerClient } from '@/lib/supabase/user-server';

export async function getAuthUser() {
  const sb = await createUserServerClient();
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
}

export async function requireAuthUser() {
  const u = await getAuthUser();
  if (!u) redirect('/create/login');
  return u;
}

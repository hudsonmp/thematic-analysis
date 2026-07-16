import 'server-only';
import { redirect } from 'next/navigation';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';

export type Role = 'admin' | 'full' | 'viewer';

/**
 * The signed-in user's role, from cb_profiles. A user with no profile row yet (the
 * ensureProfile race on first login) reads as 'full' — the pre-roles default — so a
 * momentarily-missing row never locks a legitimate editor out; the DB-level viewer
 * restriction is carried by cb_is_editor(), which checks the same table and treats a
 * missing row the same way (no row ⇒ not a viewer ⇒ editor).
 */
export async function getMyRole(): Promise<Role> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();
  const { data } = await sb
    .from('cb_profiles')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();
  const role = data?.role;
  return role === 'admin' || role === 'viewer' ? role : 'full';
}

/**
 * Gate for MUTATING server actions that write through the service-role client
 * (codebook writes: codes, facets, labels, citations). Those writes bypass RLS by
 * design, so the DB-level cb_is_editor() restriction never sees them — this is the
 * app-level equivalent, and it throws rather than redirects because actions are
 * invoked from event handlers, not navigations.
 *
 * User-client writes (annotations, comments, session status) do NOT need this: the
 * RESTRICTIVE RLS policies from migration 39 reject a viewer's JWT at the database.
 */
export async function requireEditor(): Promise<void> {
  const role = await getMyRole();
  if (role === 'viewer') {
    throw new Error('Your account is view-only — ask the study admin for edit access.');
  }
}

/** Gate for /admin and its actions. Pages redirect; actions throw. */
export async function requireAdmin(opts: { redirectTo?: string } = {}): Promise<void> {
  const role = await getMyRole();
  if (role !== 'admin') {
    if (opts.redirectTo) redirect(opts.redirectTo);
    throw new Error('Admin only.');
  }
}

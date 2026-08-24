import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';

export type Role = 'admin' | 'full' | 'viewer';

/**
 * The signed-in user's role, from cb_profiles. FAIL CLOSED: a missing row reads as
 * 'viewer', the least privilege. (An earlier 'full' default was an escalation — a
 * viewer could DELETE their own profile row via the permissive self-RW policy and
 * inherit editor rights from the absent row. This now matches cb_is_editor(), which
 * also treats a missing row as non-editor.) ensureProfile provisions the real row on
 * login/register, so the closed default only bites a genuinely rowless session.
 */
export const getMyRole = cache(async (): Promise<Role> => {
  // Per-request memoized like getAuthUser: stacked gates (requireEditor in an
  // action that also renders admin chrome, etc.) query cb_profiles once.
  const user = await requireAuthUser();
  const sb = await createUserServerClient();
  const { data } = await sb
    .from('cb_profiles')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();
  const role = data?.role;
  return role === 'admin' || role === 'full' ? role : 'viewer';
});

/**
 * Gate for MUTATING server actions that write through the service-role client
 * (codebook writes: codes, facets, labels, citations). Those writes bypass RLS by
 * design, so the DB-level cb_is_editor() restriction never sees them — this is the
 * app-level equivalent, and it throws rather than redirects because actions are
 * invoked from event handlers, not navigations.
 *
 * User-client writes covered by the RESTRICTIVE policies (annotations, session
 * status, recording marks, observations) do NOT need this — the DB rejects a viewer's
 * JWT. But SERVICE-ROLE writes (cb_coder_comments and everything in
 * codes/facets/labels/citations/episodes/flag-types) bypass RLS and MUST call
 * requireEditor here.
 */
export async function requireEditor(): Promise<void> {
  const role = await getMyRole();
  if (role === 'viewer') {
    throw new Error('Your account is view-only — ask the study admin for edit access.');
  }
}

/** Gate for `/?admin` and its actions. Pages redirect; actions throw. */
export async function requireAdmin(opts: { redirectTo?: string } = {}): Promise<void> {
  const role = await getMyRole();
  if (role !== 'admin') {
    if (opts.redirectTo) redirect(opts.redirectTo);
    throw new Error('Admin only.');
  }
}

'use server';

import { redirect } from 'next/navigation';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { cbFrom } from '@/lib/supabase/guard';

export type AuthFormState = {
  error?: string;
  // Set when signUp succeeds but the project requires email confirmation, so no
  // session was created and we cannot redirect into the (gated) app yet.
  checkEmail?: boolean;
};

/**
 * Ensure the signed-in user has a `cb_profiles` row. Idempotent: if a row
 * already exists it is left untouched.
 *
 * Uses the cookie-bound user-server client (anon key) so the insert runs as the
 * authenticated user and the table's self-RW RLS policy applies — the row's
 * `user_id` must equal `auth.uid()`. Defaults `display_name` to the email and
 * `initials` to the uppercased first two characters of the email.
 *
 * No-ops (returns) if there is no authenticated user — callers only invoke this
 * after establishing a session.
 */
export async function ensureProfile(role?: 'full' | 'viewer'): Promise<void> {
  const sb = await createUserServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return;

  // Already provisioned? Then nothing to do (idempotent).
  const existing = await sb
    .from('cb_profiles')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (existing.data) return;

  const email = user.email ?? '';
  const initials = email.slice(0, 2).toUpperCase() || null;

  const { error } = await sb.from('cb_profiles').insert({
    user_id: user.id,
    display_name: email || null,
    initials,
    // The role travels from the CLAIMED INVITE. Login-path calls omit it (an
    // existing row is never touched — idempotent), and a missing value falls to
    // the column default.
    ...(role ? { role } : {}),
  });
  // Ignore unique-violation races (a concurrent insert beat us): the row exists,
  // which is the desired post-condition. Surface anything else.
  if (error && error.code !== '23505') {
    throw new Error(`ensureProfile failed: ${error.message}`);
  }
}

/**
 * INVITE-gated registration. The shared access code is retired: an account now
 * requires a single-use invite token (minted at /admin), which carries the new
 * account's ROLE ('full' or 'viewer').
 *
 * The token is CLAIMED ATOMICALLY BEFORE the account is created — a conditional
 * UPDATE (`used_at is null`) that returns the row. Two racing registrations with the
 * same link cannot both pass: one claim wins, the other matches zero rows. If account
 * creation then fails, the claim is best-effort released so the link isn't burned by
 * a typo'd password.
 *
 * Invite reads/writes go through cbFrom (service role): cb_invites has RLS enabled
 * with NO policies, because a token in a URL is the whole credential — the table
 * must be unreadable to anon AND authenticated alike.
 *
 * Accounts are created PRE-CONFIRMED via the admin API (no confirmation email):
 * verification is redundant when every registration is already invite-gated.
 */
export async function registerAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = (formData.get('email') ?? '').toString().trim();
  const password = (formData.get('password') ?? '').toString();
  const token = (formData.get('invite') ?? '').toString().trim();

  if (!token) {
    return { error: 'Registration requires an invite link — ask the study admin.' };
  }

  // Atomic claim: mark used now; `used_by` is stamped after the account exists.
  const claim = await cbFrom('cb_invites')
    .update({ used_at: new Date().toISOString() })
    .eq('token', token)
    .is('used_at', null)
    .select('id, role')
    .maybeSingle();
  if (claim.error) return { error: `Invite check failed: ${claim.error.message}` };
  if (!claim.data) {
    return { error: 'This invite link is invalid or has already been used.' };
  }
  const invite = claim.data;
  const role = invite.role === 'viewer' ? ('viewer' as const) : ('full' as const);

  const release = async () => {
    await cbFrom('cb_invites').update({ used_at: null }).eq('id', invite.id);
  };

  const admin = createServiceRoleClient();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr && !/already|exists|registered|been registered/i.test(createErr.message)) {
    await release();
    return { error: createErr.message };
  }

  const sb = await createUserServerClient();
  const { error: signInErr } = await sb.auth.signInWithPassword({ email, password });
  if (signInErr) {
    // If an account WAS created, the invite was legitimately consumed — keep it
    // burned and stamp the consumer, so a later plain login cannot land on the
    // 'viewer' default and lose the invite's role. Only release when NO account
    // exists (the pre-existing-email fallthrough failing sign-in on a bad password).
    if (created?.user?.id) {
      await cbFrom('cb_invites').update({ used_by: created.user.id }).eq('id', invite.id);
      return { error: `${signInErr.message} — your account exists; sign in to continue.` };
    }
    await release();
    return { error: signInErr.message };
  }

  // Stamp who consumed it (the claim already burned it).
  if (created?.user?.id) {
    await cbFrom('cb_invites').update({ used_by: created.user.id }).eq('id', invite.id);
  }

  await ensureProfile(role);
  redirect('/');
}

/** Email/password sign-in. On success provisions the profile then enters the app. */
export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = (formData.get('email') ?? '').toString().trim();
  const password = (formData.get('password') ?? '').toString();

  const sb = await createUserServerClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: error.message };
  }

  await ensureProfile();
  redirect('/');
}

/** Sign the current user out and return to the login page. */
export async function logoutAction(): Promise<void> {
  const sb = await createUserServerClient();
  await sb.auth.signOut();
  redirect('/create/login');
}

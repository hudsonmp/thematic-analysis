'use server';

import { redirect } from 'next/navigation';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { createServiceRoleClient } from '@/lib/supabase/service';

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
export async function ensureProfile(): Promise<void> {
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
  });
  // Ignore unique-violation races (a concurrent insert beat us): the row exists,
  // which is the desired post-condition. Surface anything else.
  if (error && error.code !== '23505') {
    throw new Error(`ensureProfile failed: ${error.message}`);
  }
}

/**
 * Gated registration. The access code is checked BEFORE any signup attempt — a
 * wrong code must never create an `auth.users` row.
 *
 * On a successful signUp:
 *  - If the project has email confirmation OFF, signUp returns a session; we
 *    provision the profile and redirect into the app.
 *  - If email confirmation is ON, signUp returns no session (`data.session` is
 *    null); we cannot redirect into the gated app, so we surface a
 *    "check your email" state instead. The profile is provisioned later, on
 *    first login (loginAction also calls ensureProfile).
 */
export async function registerAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = (formData.get('email') ?? '').toString().trim();
  const password = (formData.get('password') ?? '').toString();
  const accessCode = (formData.get('accessCode') ?? '').toString();

  if (accessCode !== process.env.RESEARCHER_ACCESS_CODE) {
    return { error: 'Invalid access code.' };
  }

  // Create the account PRE-CONFIRMED via the service-role admin API. This sends
  // NO confirmation email (so the provider's email rate limit is never hit) and
  // the user is immediately active. Email verification is redundant here: every
  // registration is already gated by the access code above.
  const admin = createServiceRoleClient();
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  // A duplicate email means the account already exists — fall through to sign-in
  // (idempotent re-register, or a previously-stuck unconfirmed account) rather
  // than failing.
  if (createErr && !/already|exists|registered|been registered/i.test(createErr.message)) {
    return { error: createErr.message };
  }

  // Establish the cookie-bound session so we can enter the gated app.
  const sb = await createUserServerClient();
  const { error: signInErr } = await sb.auth.signInWithPassword({ email, password });
  if (signInErr) {
    return { error: signInErr.message };
  }

  await ensureProfile();
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

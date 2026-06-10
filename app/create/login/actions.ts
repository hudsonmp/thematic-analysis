'use server';

import { redirect } from 'next/navigation';
import {
  getResearcherSession,
  verifyResearcherPassword,
} from '@/lib/auth/researcher';

export type CreateLoginState = { error?: string };

// Only allow redirecting back to internal, app-relative paths (defends against
// open-redirect via a crafted `next` param). Login itself is never a valid
// post-login destination.
function safeNext(raw: string): string {
  if (raw.startsWith('/') && !raw.startsWith('//') && raw !== '/create/login') {
    return raw;
  }
  return '/';
}

export async function researcherLoginAction(
  _prev: CreateLoginState,
  formData: FormData,
): Promise<CreateLoginState> {
  const password = (formData.get('password') ?? '').toString();
  const next = safeNext((formData.get('next') ?? '').toString());

  if (!verifyResearcherPassword(password)) {
    return { error: 'Incorrect password.' };
  }

  const session = await getResearcherSession();
  session.ok = true;
  session.at = Date.now();
  await session.save();

  redirect(next);
}

'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { registerAction, type AuthFormState } from '@/app/actions/auth';

const initial: AuthFormState = {};

export default function RegisterForm({ invite }: { invite: string }) {
  const [state, formAction, isPending] = useActionState(registerAction, initial);

  return (
    <main className="flex-1 flex items-center justify-center px-6 py-16">
      <div className="max-w-md w-full">
        <header className="border-b border-foreground/15 pb-4 mb-8">
          <h1 className="text-2xl font-medium tracking-tight">
            Researcher registration
          </h1>
          <p className="text-sm text-foreground/60 mt-1">
            Invite-only: accounts are created from single-use invite links.
          </p>
        </header>

        {state.checkEmail ? (
          <div className="space-y-4">
            <p className="text-sm">
              Account created. Check your email for a confirmation link, then{' '}
              <Link
                href="/create/login"
                className="underline underline-offset-2 hover:text-foreground"
              >
                sign in
              </Link>
              .
            </p>
          </div>
        ) : (
          <form action={formAction} className="space-y-5">
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-foreground/60">
                Email
              </span>
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                className="mt-1 w-full border border-foreground/15 px-3 py-2 bg-background focus:outline-none focus:border-foreground"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase tracking-wider text-foreground/60">
                Password
              </span>
              <input
                type="password"
                name="password"
                required
                autoComplete="new-password"
                className="mt-1 w-full border border-foreground/15 px-3 py-2 bg-background focus:outline-none focus:border-foreground"
              />
            </label>

            {/* The invite token rides the URL into a hidden field. No token → say so
                up front instead of letting the submit fail. */}
            <input type="hidden" name="invite" value={invite} />
            {invite === '' && (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                This page needs an invite link (…/create/register?invite=…). Ask the
                study admin for one.
              </p>
            )}

            {state.error && (
              <p className="text-sm text-red-600">{state.error}</p>
            )}

            <button
              type="submit"
              disabled={isPending}
              className="w-full border border-foreground py-2.5 hover:bg-foreground hover:text-background transition disabled:opacity-50"
            >
              {isPending ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        )}

        <p className="text-sm text-foreground/60 mt-6">
          Already registered?{' '}
          <Link
            href="/create/login"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

'use client';

import { useActionState } from 'react';
import { researcherLoginAction, type CreateLoginState } from './actions';

const initial: CreateLoginState = {};

export default function ResearcherLoginForm({ next }: { next: string }) {
  const [state, formAction, isPending] = useActionState(
    researcherLoginAction,
    initial,
  );

  return (
    <main className="flex-1 flex items-center justify-center px-6 py-16">
      <div className="max-w-md w-full">
        <header className="border-b border-foreground/15 pb-4 mb-8">
          <h1 className="text-2xl font-medium tracking-tight">
            Researcher access
          </h1>
          <p className="text-sm text-foreground/60 mt-1">
            Restricted to study authors.
          </p>
        </header>

        <form action={formAction} className="space-y-5">
          <input type="hidden" name="next" value={next} />
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-foreground/60">
              Password
            </span>
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full border border-foreground/15 px-3 py-2 bg-background focus:outline-none focus:border-foreground"
            />
          </label>

          {state.error && (
            <p className="text-sm text-red-600">{state.error}</p>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="w-full border border-foreground py-2.5 hover:bg-foreground hover:text-background transition disabled:opacity-50"
          >
            {isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}

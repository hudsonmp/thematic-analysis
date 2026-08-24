'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createInvite,
  revokeInvite,
  setFamiliarization,
  type FamiliarizationRow,
  type InviteRow,
} from '@/app/actions/admin';

type SessionOption = { id: string; pidLabel: string; collection: string };

/**
 * The `/?admin` console body. Two sections:
 *
 * INVITES — mint a single-use link carrying the new account's role. The link IS the
 * credential (the table is unreadable to every JWT), so the UI's job is to make
 * copying it trivial and to show, per invite, whether it is still live. Used
 * invites are history, not credentials — they list who consumed them and cannot be
 * revoked (revoking history is falsifying it); unused ones can.
 *
 * FAMILIARIZATION — an ordered checklist of sessions a new coder should watch
 * before coding. Saved as ONE list (replace semantics): the order and extent are a
 * single editorial decision, and the onboarding guide replays it verbatim.
 */
export default function AdminPanel({
  invites,
  familiarization,
  sessions,
}: {
  invites: InviteRow[];
  familiarization: FamiliarizationRow[] & { pidLabel?: string }[];
  sessions: SessionOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [picked, setPicked] = useState<string[]>(
    familiarization.map((f) => ('sessionId' in f ? (f as FamiliarizationRow).sessionId : '')),
  );

  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  function run(fn: () => Promise<unknown>) {
    setError(null);
    start(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Action failed.');
      }
    });
  }

  function inviteUrl(token: string) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/create/register?invite=${token}`;
  }

  async function copy(token: string) {
    await navigator.clipboard.writeText(inviteUrl(token));
    setCopied(token);
    setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
  }

  function toggleSession(id: string) {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function move(id: string, delta: number) {
    setPicked((prev) => {
      const i = prev.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6 border-b border-foreground/15 pb-3">
        <h1 className="text-lg font-medium tracking-tight">Admin</h1>
        <p className="text-sm text-foreground/60">
          Invites and the data-familiarization list.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {/* ---------------- invites ---------------- */}
      <section className="mb-10">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Invites</h2>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => createInvite('full'))}
            className="ml-auto rounded border border-foreground px-2 py-1 text-xs transition hover:bg-foreground hover:text-background disabled:opacity-50"
          >
            + Full access
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => createInvite('viewer'))}
            className="rounded border border-foreground/40 px-2 py-1 text-xs text-foreground/70 transition hover:border-foreground hover:text-foreground disabled:opacity-50"
          >
            + View only
          </button>
        </div>
        <p className="mb-3 text-xs text-foreground/50">
          Each link creates exactly one account with the stated role. Invitees cannot
          invite others.
        </p>

        {invites.length === 0 ? (
          <p className="rounded border border-foreground/15 px-3 py-4 text-sm text-foreground/50">
            No invites yet.
          </p>
        ) : (
          <div className="space-y-1.5">
            {invites.map((inv) => (
              <div
                key={inv.id}
                className="flex flex-wrap items-center gap-2 border border-foreground/15 px-3 py-2 text-sm"
              >
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wide ${
                    inv.role === 'viewer'
                      ? 'bg-foreground/10 text-foreground/60'
                      : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
                  }`}
                >
                  {inv.role}
                </span>
                {inv.usedAt ? (
                  <span className="text-xs text-foreground/50">
                    used by <span className="font-medium">{inv.usedByName ?? 'unknown'}</span>
                  </span>
                ) : (
                  <>
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/50">
                      {inviteUrl(inv.token)}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copy(inv.token)}
                      className="rounded border border-foreground/25 px-2 py-0.5 text-xs transition hover:border-foreground"
                    >
                      {copied === inv.token ? 'Copied ✓' : 'Copy link'}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => revokeInvite(inv.id))}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------------- familiarization ---------------- */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Data familiarization</h2>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => setFamiliarization(picked))}
            className="ml-auto rounded border border-foreground px-2 py-1 text-xs transition hover:bg-foreground hover:text-background disabled:opacity-50"
          >
            Save list
          </button>
        </div>
        <p className="mb-3 text-xs text-foreground/50">
          The sessions a new coder is prompted to watch at the end of the onboarding
          guide, in this order.
        </p>

        {picked.length > 0 && (
          <ol className="mb-3 space-y-1">
            {picked.map((id, i) => {
              const s = sessionById.get(id);
              return (
                <li
                  key={id}
                  className="flex items-center gap-2 border border-foreground/15 px-3 py-1.5 text-sm"
                >
                  <span className="w-5 text-xs text-foreground/40">{i + 1}.</span>
                  <span className="font-mono text-xs">{s?.pidLabel ?? id}</span>
                  <span className="text-xs text-foreground/40">{s?.collection}</span>
                  <span className="ml-auto flex gap-1">
                    <button type="button" onClick={() => move(id, -1)} className="px-1 text-xs text-foreground/50 hover:text-foreground">↑</button>
                    <button type="button" onClick={() => move(id, 1)} className="px-1 text-xs text-foreground/50 hover:text-foreground">↓</button>
                    <button type="button" onClick={() => toggleSession(id)} className="px-1 text-xs text-red-600">×</button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        <details className="rounded border border-foreground/15 px-3 py-2">
          <summary className="cursor-pointer text-xs text-foreground/60">
            Add sessions ({sessions.length})
          </summary>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {sessions
              .filter((s) => !picked.includes(s.id))
              .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleSession(s.id)}
                  className="flex items-center gap-2 border border-foreground/10 px-2 py-1 text-left text-xs transition hover:border-foreground/40"
                >
                  <span className="font-mono">{s.pidLabel}</span>
                  <span className="text-foreground/40">{s.collection}</span>
                </button>
              ))}
          </div>
        </details>
      </section>
    </main>
  );
}

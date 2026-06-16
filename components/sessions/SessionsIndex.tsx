'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  deleteSessionCloud,
  updateSessionCollection,
  type SessionListRow,
} from '@/app/actions/sessions';
import { collectionOptions } from '@/lib/sessions/collections';

/** Format a millisecond duration as `mm:ss` (minutes uncapped past 60). */
function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The interactive sessions index. A client island (the parent page is a Server
 * Component that fetches `rows`): it groups sessions by collection and lets the
 * researcher (a) reassign a session's collection inline — which regroups on the
 * next refresh — and (b) permanently delete a session.
 *
 * Mutations follow the repo convention: a Server Action called from an event
 * handler inside a transition, then `router.refresh()` re-runs the parent loader so
 * the grouping reflects the new state. Controls disable while the round-trip is in
 * flight. Deletion is irreversible and gated behind a `confirm()`.
 */
export default function SessionsIndex({ rows }: { rows: SessionListRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Mutation failed.');
      }
    });
  }

  // Group by collection, preserving the collection-then-created_at order the loader
  // already returned (Map keeps insertion order).
  const byCollection = useMemo(() => {
    const m = new Map<string, SessionListRow[]>();
    for (const row of rows) {
      const group = m.get(row.collection);
      if (group) group.push(row);
      else m.set(row.collection, [row]);
    }
    return m;
  }, [rows]);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-foreground/60">
        No sessions yet. Use “Upload sessions →” to add recordings.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {Array.from(byCollection.entries()).map(([collection, group]) => (
        <section key={collection}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground/50">
            {collection}{' '}
            <span className="font-normal normal-case text-foreground/30">
              · {group.length}
            </span>
          </h2>
          <table className="w-full max-w-2xl text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-foreground/50 border-b border-foreground/15">
                <th className="py-2 pr-4 font-medium">PID</th>
                <th className="py-2 pr-4 font-medium">Collection</th>
                <th className="py-2 pr-4 font-medium">Duration</th>
                <th className="py-2 pr-4 font-medium" />
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {group.map((row) => (
                <tr key={row.id} className="border-b border-foreground/10">
                  <td className="py-2 pr-4 font-mono">{row.pidLabel}</td>
                  <td className="py-2 pr-4">
                    <select
                      value={row.collection}
                      disabled={isPending}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v !== row.collection) {
                          run(() => updateSessionCollection(row.id, v));
                        }
                      }}
                      aria-label={`Collection for ${row.pidLabel}`}
                      className="rounded border border-foreground/20 bg-background px-2 py-1 text-sm disabled:opacity-50"
                    >
                      {collectionOptions(row.collection).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-4 font-mono text-foreground/70">
                    {formatDuration(row.durationMs)}
                  </td>
                  <td className="py-2 pr-4">
                    <Link
                      href={`/sessions/${row.id}`}
                      className="text-foreground/70 underline-offset-2 hover:text-foreground hover:underline transition"
                    >
                      Open →
                    </Link>
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => {
                        if (
                          confirm(
                            `Delete session ${row.pidLabel}?\n\nThis permanently removes its transcript, annotations, codes, and comments. This cannot be undone.`,
                          )
                        ) {
                          run(() => deleteSessionCloud(row.id));
                        }
                      }}
                      aria-label={`Delete session ${row.pidLabel}`}
                      title="Delete session"
                      className="px-1 text-red-600 hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

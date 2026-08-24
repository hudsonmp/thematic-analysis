'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  setActionCoderStatus,
  type ActionCodingSessionRow,
} from '@/app/actions/action-coding';
import { CODER_STATUSES, statusLabel } from '@/lib/codebook/sessionProgress';

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The /coding/action index: sessions grouped by collection, each with THIS
 * coder's action-coding status (independent of the codebook status on
 * /sessions — same three states, separate table) and an Open link to the
 * action-layer player. Collection / reconciliation / delete / note live on
 * /sessions only; this list is about action-coding progress.
 */
export default function ActionCodingIndex({
  rows,
  readOnly = false,
}: {
  rows: ActionCodingSessionRow[];
  readOnly?: boolean;
}) {
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

  const byCollection = useMemo(() => {
    const m = new Map<string, ActionCodingSessionRow[]>();
    for (const row of rows) {
      const group = m.get(row.collection);
      if (group) group.push(row);
      else m.set(row.collection, [row]);
    }
    return m;
  }, [rows]);

  if (rows.length === 0) {
    return <p className="text-sm text-foreground/60">No sessions yet. Upload recordings on Sessions first.</p>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {Array.from(byCollection.entries()).map(([collection, group]) => {
        const doneCount = group.filter((r) => r.status === 'individual_coding').length;
        return (
          <section key={collection}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground/50">
              {collection}{' '}
              <span className="font-normal normal-case text-foreground/30">
                · {group.length} · {doneCount}/{group.length} through individual action coding
              </span>
            </h2>
            <div className="max-w-3xl space-y-3">
              {group.map((row) => (
                <div key={row.id} className="border border-foreground/15 p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-sm">{row.pidLabel}</span>
                    <select
                      value={row.status}
                      disabled={isPending || readOnly}
                      onChange={(e) =>
                        run(() =>
                          setActionCoderStatus(row.id, e.target.value as (typeof CODER_STATUSES)[number]),
                        )
                      }
                      aria-label={`Your action-coding status for ${row.pidLabel}`}
                      title="Your action-coding status (per-coder, separate from codebook coding)"
                      className="rounded border border-foreground/20 bg-background px-2 py-1 text-xs disabled:opacity-60"
                    >
                      {CODER_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {statusLabel(s)}
                        </option>
                      ))}
                    </select>
                    <span className="font-mono text-xs text-foreground/50">{formatDuration(row.durationMs)}</span>
                    <span className="text-xs text-foreground/50">
                      {row.myAnnotationCount} action span{row.myAnnotationCount === 1 ? '' : 's'}
                    </span>
                    <span className="ml-auto text-xs text-foreground/50">{statusLabel(row.status)}</span>
                    <Link
                      href={`/coding/action/${row.id}`}
                      className="text-xs text-foreground/70 underline-offset-2 transition hover:text-foreground hover:underline"
                    >
                      Open →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

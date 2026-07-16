'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  deleteSessionCloud,
  setCoderStatus,
  setReconciliation,
  setSessionNote,
  updateSessionCollection,
  type SessionListRow,
} from '@/app/actions/sessions';
import { collectionOptions } from '@/lib/sessions/collections';
import {
  CODER_STATUSES,
  displayStatus,
  statusLabel,
} from '@/lib/codebook/sessionProgress';

/** The shared coordination comment on a session row. Commits on blur; a blank clears it.
 *  Uncontrolled-by-key: remounts when the saved note changes so it never fights an
 *  in-flight edit. */
function NoteField({
  pid,
  initial,
  disabled,
  onSave,
}: {
  pid: string;
  initial: string;
  disabled: boolean;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <input
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== initial.trim()) onSave(text);
      }}
      placeholder="Add a comment…"
      aria-label={`Comment on ${pid}`}
      className="mt-2 w-full border-b border-dashed border-foreground/20 bg-transparent py-1 text-xs text-foreground/70 focus:border-solid focus:border-foreground focus:outline-none disabled:opacity-50"
    />
  );
}

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
export default function SessionsIndex({
  rows,
  readOnly = false,
}: {
  rows: SessionListRow[];
  /** Viewer accounts browse and open sessions but mutate nothing — the DB would
   *  reject them anyway (restrictive RLS); disabling the controls says so up front
   *  instead of letting every click fail loudly. */
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
      {Array.from(byCollection.entries()).map(([collection, group]) => {
        // "coded" now means the coder reached individual_coding OR the session is in
        // reconciliation — i.e. their independent pass is done.
        const codedCount = group.filter(
          (r) =>
            r.reconciliationAt != null || r.coderStatus === 'individual_coding',
        ).length;
        return (
          <section key={collection}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground/50">
              {collection}{' '}
              <span className="font-normal normal-case text-foreground/30">
                · {group.length} · {codedCount}/{group.length} through individual coding
              </span>
            </h2>
            <div className="max-w-3xl space-y-3">
              {group.map((row) => {
                const shown = displayStatus(row.coderStatus, row.reconciliationAt);
                const inReconciliation = row.reconciliationAt != null;
                return (
                  <div
                    key={row.id}
                    className="border border-foreground/15 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-sm">{row.pidLabel}</span>

                      {/* Per-coder status. Disabled while in reconciliation, because the
                          session-level override is what's shown — editing your own status
                          under it would be invisible and misleading. */}
                      <select
                        value={inReconciliation ? 'reconciliation' : row.coderStatus}
                        disabled={isPending || readOnly || inReconciliation}
                        onChange={(e) =>
                          run(() =>
                            setCoderStatus(
                              row.id,
                              e.target.value as (typeof CODER_STATUSES)[number],
                            ),
                          )
                        }
                        aria-label={`Your status for ${row.pidLabel}`}
                        title={
                          inReconciliation
                            ? 'Session is in reconciliation — this overrides your per-coder status'
                            : 'Your coding status (per-coder)'
                        }
                        className="rounded border border-foreground/20 bg-background px-2 py-1 text-xs disabled:opacity-60"
                      >
                        {inReconciliation ? (
                          <option value="reconciliation">{statusLabel('reconciliation')}</option>
                        ) : (
                          CODER_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {statusLabel(s)}
                            </option>
                          ))
                        )}
                      </select>

                      {/* Reconciliation is a SESSION toggle (shared, overrides everyone). */}
                      <label className="flex items-center gap-1 text-xs text-foreground/60">
                        <input
                          type="checkbox"
                          checked={inReconciliation}
                          disabled={isPending || readOnly}
                          onChange={(e) =>
                            run(() => setReconciliation(row.id, e.target.checked))
                          }
                          className="h-3.5 w-3.5 cursor-pointer accent-foreground/70"
                        />
                        Reconciliation
                      </label>

                      <select
                        value={row.collection}
                        disabled={isPending || readOnly}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v !== row.collection) run(() => updateSessionCollection(row.id, v));
                        }}
                        aria-label={`Collection for ${row.pidLabel}`}
                        className="rounded border border-foreground/20 bg-background px-2 py-1 text-xs disabled:opacity-50"
                      >
                        {collectionOptions(row.collection).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>

                      <span className="font-mono text-xs text-foreground/50">
                        {formatDuration(row.durationMs)}
                      </span>

                      <span
                        className={`ml-auto text-xs ${
                          shown === 'reconciliation'
                            ? 'text-amber-700 dark:text-amber-500'
                            : 'text-foreground/50'
                        }`}
                      >
                        {statusLabel(shown)}
                      </span>

                      <Link
                        href={`/sessions/${row.id}`}
                        className="text-xs text-foreground/70 underline-offset-2 transition hover:text-foreground hover:underline"
                      >
                        Open →
                      </Link>
                      <button
                        type="button"
                        disabled={isPending || readOnly}
                        onClick={() => {
                          if (
                            confirm(
                              `Delete session ${row.pidLabel}?\n\nThis permanently removes its transcript, annotations, codes, and comments. This cannot be undone.`,
                            )
                          ) {
                            run(() => deleteSessionCloud(row.id));
                          }
                        }}
                        className="text-xs text-red-600 hover:underline disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>

                    {/* Shared coordination comment, PID already labels the row. Commits on
                        blur; blank clears it. */}
                    <NoteField
                      key={`${row.id}:${row.note ?? ''}`}
                      pid={row.pidLabel}
                      initial={row.note ?? ''}
                      disabled={isPending || readOnly}
                      onSave={(text) => run(() => setSessionNote(row.id, text))}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

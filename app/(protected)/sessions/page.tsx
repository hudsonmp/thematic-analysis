import Link from 'next/link';
import { listSessionsCloud, type SessionListRow } from '@/app/actions/sessions';

/**
 * The session index. A Server Component: it lists cloud sessions via
 * `listSessionsCloud()` (a `cb_sessions` read ordered by collection then
 * created_at) and renders them grouped by collection. Each row links to the
 * per-session player at `/sessions/<id>`. Participant identity is shown by
 * pid_label ONLY (no name) — these are coded recordings.
 */

/** Format a millisecond duration as `mm:ss` (minutes uncapped past 60). */
function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default async function SessionsPage() {
  const rows = await listSessionsCloud();

  // Group rows by collection, preserving the collection-then-created_at order
  // the query already returned (Map keeps insertion order).
  const byCollection = new Map<string, SessionListRow[]>();
  for (const row of rows) {
    const group = byCollection.get(row.collection);
    if (group) group.push(row);
    else byCollection.set(row.collection, [row]);
  }

  return (
    <main className="px-6 py-6">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Sessions</h1>
          <p className="text-sm text-foreground/60">
            Participant recordings. Open one to watch the video with its
            synchronized transcript.
          </p>
        </div>
        <Link
          href="/sessions/upload"
          className="shrink-0 rounded border border-foreground/25 px-3 py-1.5 text-sm transition hover:bg-foreground/5"
        >
          Upload sessions →
        </Link>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-foreground/60">
          No sessions yet. Use “Upload sessions →” to add recordings.
        </p>
      ) : (
        <div className="space-y-6">
          {Array.from(byCollection.entries()).map(([collection, group]) => (
            <section key={collection}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground/50">
                {collection}
              </h2>
              <table className="w-full max-w-2xl text-sm border-collapse">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-foreground/50 border-b border-foreground/15">
                    <th className="py-2 pr-4 font-medium">PID</th>
                    <th className="py-2 pr-4 font-medium">Collection</th>
                    <th className="py-2 pr-4 font-medium">Duration</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {group.map((row) => (
                    <tr key={row.id} className="border-b border-foreground/10">
                      <td className="py-2 pr-4 font-mono">{row.pidLabel}</td>
                      <td className="py-2 pr-4 text-foreground/70">
                        {row.collection}
                      </td>
                      <td className="py-2 pr-4 font-mono text-foreground/70">
                        {formatDuration(row.durationMs)}
                      </td>
                      <td className="py-2">
                        <Link
                          href={`/sessions/${row.id}`}
                          className="text-foreground/70 underline-offset-2 hover:text-foreground hover:underline transition"
                        >
                          Open →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

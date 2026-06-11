import Link from 'next/link';
import { listSessions, getSession } from '@/lib/sessions/discover';

/**
 * The session index. A Server Component: it enumerates on-disk recordings via
 * `listSessions()` and, for each, resolves a display row (participant first name
 * + duration) through `getSession(pid)`. Calling `getSession` per row re-parses
 * each SRT and does a users lookup; that is acceptable at this scale (a handful
 * of recordings) and keeps a single discovery surface. The rows link to the
 * per-session player at `/sessions/<pid>`.
 */

/** Format a millisecond duration as `mm:ss` (minutes uncapped past 60). */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

type Row = { pid: string; firstName: string | null; durationMs: number };

export default async function SessionsPage() {
  const metas = listSessions();

  // Resolve each row in parallel. A single failed lookup shouldn't 500 the
  // whole index, so any rejection degrades to a row with unknown name/duration.
  const rows: Row[] = await Promise.all(
    metas.map(async (m): Promise<Row> => {
      try {
        const { firstName, durationMs } = await getSession(m.pid);
        return { pid: m.pid, firstName, durationMs };
      } catch {
        return { pid: m.pid, firstName: null, durationMs: 0 };
      }
    }),
  );

  return (
    <main className="px-6 py-6">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Sessions</h1>
          <p className="text-sm text-foreground/60">
            Participant recordings discovered on disk. Open one to watch the
            video with its synchronized transcript.
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
          No recordings found in RECORDINGS_DIR.
        </p>
      ) : (
        <table className="w-full max-w-2xl text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-foreground/50 border-b border-foreground/15">
              <th className="py-2 pr-4 font-medium">PID</th>
              <th className="py-2 pr-4 font-medium">Participant</th>
              <th className="py-2 pr-4 font-medium">Duration</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.pid} className="border-b border-foreground/10">
                <td className="py-2 pr-4 font-mono">{row.pid}</td>
                <td className="py-2 pr-4">{row.firstName ?? '—'}</td>
                <td className="py-2 pr-4 font-mono text-foreground/70">
                  {formatDuration(row.durationMs)}
                </td>
                <td className="py-2">
                  <Link
                    href={`/sessions/${row.pid}`}
                    className="text-foreground/70 underline-offset-2 hover:text-foreground hover:underline transition"
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

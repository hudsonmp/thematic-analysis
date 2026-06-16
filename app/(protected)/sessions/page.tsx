import Link from 'next/link';
import { listSessionsCloud } from '@/app/actions/sessions';
import SessionsIndex from '@/components/sessions/SessionsIndex';

/**
 * The session index. A Server Component: it lists cloud sessions via
 * `listSessionsCloud()` (a `cb_sessions` read ordered by collection then
 * created_at) and hands the rows to {@link SessionsIndex}, a client island that
 * groups them by collection and provides inline collection reassignment + delete.
 * Each row links to the per-session player at `/sessions/<id>`. Participant identity
 * is shown by pid_label ONLY (no name) — these are coded recordings.
 */
export default async function SessionsPage() {
  const rows = await listSessionsCloud();

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

      <SessionsIndex rows={rows} />
    </main>
  );
}

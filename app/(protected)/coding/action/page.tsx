import { listActionCodingSessions } from '@/app/actions/action-coding';
import { getMyRole } from '@/lib/auth/roles';
import ActionCodingIndex from '@/components/sessions/ActionCodingIndex';

/**
 * /coding/action — the ACTION-layer coding index. Same sessions as /sessions,
 * but the per-session status is this coder's ACTION-coding progress
 * (cb_action_coding_status — every session starts Not Started here regardless
 * of its codebook-coding status), and each row opens the action-layer player at
 * /coding/action/<id>. The legacy index and statuses are untouched.
 */
export default async function ActionCodingIndexPage() {
  const [rows, role] = await Promise.all([listActionCodingSessions(), getMyRole()]);
  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">Action coding</h1>
        <p className="text-sm text-foreground/60">
          Code sessions with ACTIONS (moves × objects) instead of codebook codes. Progress here is
          separate from the codebook coding on Sessions.
        </p>
      </header>
      <ActionCodingIndex rows={rows} readOnly={role === 'viewer'} />
    </main>
  );
}

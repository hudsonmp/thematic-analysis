import { requireAdmin } from '@/lib/auth/roles';
import { listInvites, listFamiliarization } from '@/app/actions/admin';
import { listSessionsCloud } from '@/app/actions/sessions';
import AdminPanel from './AdminPanel';

/**
 * /admin — the study admin's console: mint single-use invite links (full or
 * view-only; invitees can never invite) and curate the DATA-FAMILIARIZATION list
 * (the sessions a new coder is prompted to watch at the end of the onboarding
 * guide).
 *
 * The page redirects non-admins, but the page is not the security boundary — every
 * action in app/actions/admin.ts re-checks requireAdmin() itself.
 */
export default async function AdminPage() {
  await requireAdmin({ redirectTo: '/' });

  const [invites, familiarization, sessions] = await Promise.all([
    listInvites(),
    listFamiliarization(),
    listSessionsCloud(),
  ]);

  return (
    <AdminPanel
      invites={invites}
      familiarization={familiarization}
      sessions={sessions.map((s) => ({
        id: s.id,
        pidLabel: s.pidLabel,
        collection: s.collection,
      }))}
    />
  );
}

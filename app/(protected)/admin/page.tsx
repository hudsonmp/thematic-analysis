import { requireAdmin } from '@/lib/auth/roles';
import { listInvites, listFamiliarization } from '@/app/actions/admin';
import { listSessionsCloud } from '@/app/actions/sessions';
import AdminPanel from '@/components/admin/AdminPanel';

/**
 * /admin — the study admin's console: mint single-use invite links (full or
 * view-only; invitees can never invite) and curate the DATA-FAMILIARIZATION
 * list (the sessions a new coder is prompted to watch at the end of the
 * onboarding guide).
 *
 * This console briefly lived only behind `/?admin` on the scheme page, which
 * left the one screen that ADDS COMPUTERS-USERS to the study reachable only by
 * typing a query string. It is a real route again, linked from the Codebook
 * menu for admins (lib/nav/menu.ts). `/?admin` still redirects here so older
 * bookmarks keep working and there is exactly one canonical location.
 *
 * The page redirects non-admins, but the page is NOT the security boundary —
 * every action in app/actions/admin.ts re-checks requireAdmin() itself.
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
      sessions={sessions.map((session) => ({
        id: session.id,
        pidLabel: session.pidLabel,
        collection: session.collection,
      }))}
    />
  );
}

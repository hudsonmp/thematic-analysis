import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getOrCreateCodebook, getShownStudy, listCodebooks } from '@/app/actions/codebook';
import type { CodebookOption } from '@/components/CodebookSwitcher';
import CodebookNav from './CodebookNav';
import GuidePrompt from './GuidePrompt';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  // Supabase Auth is the real gate. `requireAuthUser()` reads the cookie-bound
  // session and redirects to /create/login when there is no signed-in user.
  const user = await requireAuthUser();

  // Researcher display name for the nav chrome. The profile row is provisioned
  // at login (ensureProfile), but tolerate its absence by falling back to the
  // email so the shell still renders.
  const sb = await createUserServerClient();
  const { data: profile } = await sb
    .from('cb_profiles')
    .select('display_name, role')
    .eq('user_id', user.id)
    .maybeSingle();
  const displayName = profile?.display_name ?? user.email ?? 'Researcher';
  const isAdmin = profile?.role === 'admin';
  // Editor-ness for the switcher's create/rename affordances, derived from the
  // profile row ALREADY fetched above — same fail-closed reading as getMyRole
  // (missing row ⇒ viewer ⇒ no edit affordances). The server actions re-gate
  // via requireEditor regardless; this only controls what the nav renders.
  const canEditCodebooks = profile?.role === 'admin' || profile?.role === 'full';

  // Data for the nav chrome. Fetched here (a Server Component) and passed as
  // props into the Client nav. Tolerant of a missing/unbound study so the shell
  // still renders rather than 500-ing the whole protected tree — the page-level
  // empty states handle the "no study/codebook" case in detail.
  let studyName: string | null = null;
  let codebooks: CodebookOption[] = [];
  let activeCodebookId: string | null = null;
  try {
    const [study, codebook] = await Promise.all([
      getShownStudy(),
      getOrCreateCodebook(),
    ]);
    studyName = study?.name ?? null;
    activeCodebookId = codebook?.id ?? null;
    // After getOrCreateCodebook, so a first-visit bind shows up in the list.
    codebooks = (await listCodebooks()).map(({ id, name }) => ({ id, name }));
  } catch {
    // No shown study to bind to; leave the nav data empty.
  }

  return (
    <div className="min-h-full flex flex-col">
      <CodebookNav
        studyName={studyName}
        codebooks={codebooks}
        activeCodebookId={activeCodebookId}
        canEditCodebooks={canEditCodebooks}
        displayName={displayName}
        isAdmin={isAdmin}
      />
      <GuidePrompt />
      {children}
    </div>
  );
}

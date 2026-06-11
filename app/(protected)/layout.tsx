import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getOrCreateCodebook, getShownStudy } from '@/app/actions/codebook';
import CodebookNav from './CodebookNav';

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
    .select('display_name')
    .eq('user_id', user.id)
    .maybeSingle();
  const displayName = profile?.display_name ?? user.email ?? 'Researcher';

  // Names for the nav chrome. Fetched here (a Server Component) and passed as
  // props into the Client nav. Tolerant of a missing/unbound study so the shell
  // still renders rather than 500-ing the whole protected tree — the page-level
  // empty states handle the "no study/codebook" case in detail.
  let studyName: string | null = null;
  let codebookName: string | null = null;
  try {
    const [study, codebook] = await Promise.all([
      getShownStudy(),
      getOrCreateCodebook(),
    ]);
    studyName = study?.name ?? null;
    codebookName = codebook?.name ?? null;
  } catch {
    // No shown study to bind to; leave names null.
  }

  return (
    <div className="min-h-full flex flex-col">
      <CodebookNav
        studyName={studyName}
        codebookName={codebookName}
        displayName={displayName}
      />
      {children}
    </div>
  );
}

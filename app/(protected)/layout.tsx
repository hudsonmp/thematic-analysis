import { redirect } from 'next/navigation';
import { getResearcherSession } from '@/lib/auth/researcher';
import { getOrCreateCodebook, getShownStudy } from '@/app/actions/codebook';
import CodebookNav from './CodebookNav';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await getResearcherSession();
  if (!session.ok) redirect('/create/login');

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
      <CodebookNav studyName={studyName} codebookName={codebookName} />
      {children}
    </div>
  );
}

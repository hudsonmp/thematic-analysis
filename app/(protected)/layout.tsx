import { redirect } from 'next/navigation';
import { getResearcherSession } from '@/lib/auth/researcher';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await getResearcherSession();
  if (!session.ok) redirect('/create/login');
  return <>{children}</>;
}

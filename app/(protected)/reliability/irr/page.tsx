import { listIrrSessions } from '@/app/actions/irr';
import IrrReportView from '@/components/irr/IrrReport';

/**
 * IRR (EasyDIAg) page. Server Component: lists the sessions that have two
 * coders (the only ones IRR can run on) and hands them to the client, which
 * computes the report on demand. Read-only throughout — this route never
 * writes and is entirely separate from the coding surface.
 */
export default async function IrrPage() {
  const sessions = await listIrrSessions();
  return <IrrReportView sessions={sessions} />;
}

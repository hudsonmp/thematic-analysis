import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { listInvites, listFamiliarization } from '@/app/actions/admin';
import { listSessionsCloud } from '@/app/actions/sessions';
import { getCitation } from '@/app/actions/citations';
import { requireAdmin } from '@/lib/auth/roles';
import SchemeView from '@/components/codebook/SchemeView';
import AdminPanel from '@/components/admin/AdminPanel';

/**
 * The scheme / matrix page, with the admin console intentionally hidden behind
 * `/?admin` instead of occupying permanent navigation or its own route. In
 * Next 16 `searchParams` is a Promise and must be awaited (reading it opts the
 * page into dynamic rendering).
 *
 * Deductive coding ("code from citation"): when `?fromCitation=<id>` is present
 * we resolve that citation and hand it through SchemeView to MatrixView as
 * `boundCitation`. The matrix then renders a "Deriving codes from <paper>" banner
 * and puts the new-code form in bound mode (auto-link derived_from + default
 * origin=a_priori, persisting across successive creates). A stale/unknown id
 * resolves to null, so the page falls back to the ordinary unbound matrix rather
 * than erroring.
 *
 * The page stays a Server Component: it fetches the tree + citation and passes
 * serializable props to SchemeView, the Client Component holding the Matrix |
 * Folders toggle (default Matrix, so this is non-disruptive).
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const query = await searchParams;

  if (query.admin !== undefined) {
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

  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);

  const raw = query.fromCitation;
  const fromCitation = Array.isArray(raw) ? raw[0] : raw;
  const boundCitation = fromCitation ? await getCitation(fromCitation) : null;

  return <SchemeView tree={tree} boundCitation={boundCitation} />;
}

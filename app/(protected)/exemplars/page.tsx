import { Suspense } from 'react';
import { getOrCreateCodebook } from '@/app/actions/codebook';
import { getExemplarDoc, listExemplarTabs } from '@/app/actions/exemplars';
import { getMyRole } from '@/lib/auth/roles';
import ExemplarsWorkspace from '@/components/exemplars/ExemplarsWorkspace';

/**
 * /exemplars — the admin-authored worked-example document, one tab per code.
 *
 * Server Component: resolves the active codebook, derives the tab list from its
 * codes, and preloads the requested tab (`?code=<id>`, else the first) so the
 * editor mounts with content rather than a flash. Only the ADMIN role can edit;
 * everyone else gets the same page read-only (the actions enforce this again).
 * In Next 16 `searchParams` is a Promise.
 */
export default async function ExemplarsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [cb, role, sp] = await Promise.all([getOrCreateCodebook(), getMyRole(), searchParams]);
  const tabs = await listExemplarTabs(cb.id);
  const requested = typeof sp.code === 'string' ? sp.code : null;
  const initialCodeId =
    (requested && tabs.some((t) => t.codeId === requested) ? requested : null) ?? tabs[0]?.codeId ?? null;
  const initialDoc = initialCodeId ? await getExemplarDoc(initialCodeId) : null;

  return (
    <Suspense fallback={null}>
      <ExemplarsWorkspace
        codebookId={cb.id}
        tabs={tabs}
        initialCodeId={initialCodeId}
        initialDoc={initialDoc}
        canEdit={role === 'admin'}
      />
    </Suspense>
  );
}

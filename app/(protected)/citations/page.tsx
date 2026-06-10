import { getOrCreateCodebook } from '@/app/actions/codebook';
import { listCitations } from '@/app/actions/citations';
import CitationLibrary from '@/components/citations/CitationLibrary';

/**
 * The reference-library page. A Server Component: it resolves the codebook and
 * loads its citations, then hands both to the client `CitationLibrary`. No
 * Server Actions are invoked during client render — the client component calls
 * them from event handlers and `router.refresh()`es to re-run this loader.
 */
export default async function CitationsPage() {
  const cb = await getOrCreateCodebook();
  const citations = await listCitations(cb.id);

  return <CitationLibrary codebookId={cb.id} citations={citations} />;
}

import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import CodebookEntry from '@/components/codebook/CodebookEntry';

/**
 * The Codebook page (server). A fast, scheme-derived spreadsheet surface for
 * bulk code entry — the complement to the Scheme page's single inline "New code"
 * form.
 *
 * Server Component: it resolves the active codebook and reads the codebook tree
 * (for the facets that define the grid's COLUMNS and the citation library for
 * the session binding), then hands both to the client `CodebookEntry`. The grid
 * renders one column per facet, by the facet's TYPE. The bulk create is a Server
 * Action (`createCodesBulkWithFacets`) the client invokes from a handler — no
 * Server Action runs during client render. The session "mode" (origin) and
 * optional bound citation are client state that apply to every code created in
 * the session.
 */
export default async function CodebookPage() {
  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);

  return (
    <CodebookEntry codebookId={cb.id} facets={tree.facets} citations={tree.citations} />
  );
}

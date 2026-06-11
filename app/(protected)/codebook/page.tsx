import { getOrCreateCodebook } from '@/app/actions/codebook';
import { listCitations } from '@/app/actions/citations';
import CodebookEntry from '@/components/codebook/CodebookEntry';

/**
 * The Codebook page (server). A fast, spreadsheet-style surface for bulk code
 * entry — the complement to the Scheme page's single inline "New code" form.
 *
 * Server Component: it resolves the active codebook and its citation library,
 * then hands both to the client `CodebookEntry`. The bulk create is a Server
 * Action (`createCodesBulk`) the client invokes from a handler — no Server Action
 * runs during client render. The session "mode" (origin) and optional bound
 * citation are client state that apply to every code created in the session.
 */
export default async function CodebookPage() {
  const cb = await getOrCreateCodebook();
  const citations = await listCitations(cb.id);

  return <CodebookEntry codebookId={cb.id} citations={citations} />;
}

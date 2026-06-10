import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import ExportView from '@/components/export/ExportView';

/**
 * The export page. A Server Component: it resolves the codebook and loads the
 * full tree, then hands both to the client `ExportView`. The LaTeX is rendered
 * client-side from the tree prop (pure renderer); JSON downloads route back
 * through a server action because the JSON export module is server-only.
 */
export default async function ExportPage() {
  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);

  return <ExportView codebookId={cb.id} tree={tree} />;
}

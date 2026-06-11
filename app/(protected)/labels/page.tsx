import { getOrCreateCodebook } from '@/app/actions/codebook';
import { listLabels } from '@/app/actions/labels';
import LabelManager from '@/components/labels/LabelManager';

/**
 * The label manager page. A Server Component: it resolves the codebook and loads
 * its labels, then hands both to the client `LabelManager`. No Server Actions
 * are invoked during client render — the client calls them from event handlers
 * and `router.refresh()`es to re-run this loader.
 */
export default async function LabelsPage() {
  const cb = await getOrCreateCodebook();
  const labels = await listLabels(cb.id);

  return <LabelManager codebookId={cb.id} labels={labels} />;
}

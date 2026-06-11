import { getOrCreateCodebook } from '@/app/actions/codebook';
import { listFlagTypes } from '@/app/actions/flag-types';
import FlagTypeManager from '@/components/flags/FlagTypeManager';

/**
 * The flag-taxonomy manager page. A Server Component: it resolves the codebook
 * and loads its flag types, then hands both to the client `FlagTypeManager`. No
 * Server Actions are invoked during client render — the client calls them from
 * event handlers and `router.refresh()`es to re-run this loader.
 */
export default async function FlagTypesPage() {
  const cb = await getOrCreateCodebook();
  const flagTypes = await listFlagTypes(cb.id);

  return <FlagTypeManager codebookId={cb.id} flagTypes={flagTypes} />;
}

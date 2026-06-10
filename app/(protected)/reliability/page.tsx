import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { listFrozenVersions } from '@/app/actions/freeze';
import { listReliabilityRuns } from '@/app/actions/reliability';
import ReliabilityPanel from '@/components/reliability/ReliabilityPanel';

/**
 * The §2.9 inter-rater-reliability surface. A Server Component: it resolves the
 * codebook, then loads its frozen versions, its reliability runs, and the
 * codebook tree (the tree supplies the facet-value + code option lists for the
 * scope selectors). All four are handed to the client `ReliabilityPanel`. No
 * Server Action is invoked during client render — the client calls them from
 * event handlers and `router.refresh()`es to re-run this loader.
 */
export default async function ReliabilityPage() {
  const cb = await getOrCreateCodebook();
  const [frozenVersions, runs, tree] = await Promise.all([
    listFrozenVersions(cb.id),
    listReliabilityRuns(cb.id),
    listCodebookTree(cb.id),
  ]);

  return (
    <ReliabilityPanel
      codebookId={cb.id}
      frozenVersions={frozenVersions}
      runs={runs}
      facets={tree.facets}
      codes={tree.codes}
    />
  );
}

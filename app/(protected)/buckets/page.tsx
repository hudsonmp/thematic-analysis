import { getOrCreateCodebook } from '@/app/actions/codebook';
import { getCombinatorialContext } from '@/app/actions/buckets';
import { getMyRole } from '@/lib/auth/roles';
import BucketManager from '@/components/buckets/BucketManager';

/**
 * The MODULAR BUCKETS reference (combinatorial codebook v2): the running list
 * of shared buckets — a bucket = a general action housing member codes — with
 * modular member editing and snapshot cutting. FORKS live elsewhere by design:
 * a fork is an overlay on one code's STEP SLOT, edited in that code's drawer
 * (STEPS section) on the tree page, not here.
 */
export default async function BucketsPage() {
  const codebook = await getOrCreateCodebook();
  const [ctx, role] = await Promise.all([
    getCombinatorialContext(codebook.id),
    getMyRole(),
  ]);

  return (
    <BucketManager
      codebookId={codebook.id}
      buckets={ctx.buckets}
      defs={ctx.defs}
      latestSnapshotId={ctx.latestSnapshotId}
      codeOptions={ctx.codes}
      readOnly={role === 'viewer'}
    />
  );
}

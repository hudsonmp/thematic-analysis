import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { getCombinatorialContext } from '@/app/actions/buckets';
import { getMyRole } from '@/lib/auth/roles';
import BucketManager from '@/components/buckets/BucketManager';
import { toComboCodes } from '@/lib/codebook/comboCodes';

/**
 * The MODULAR BUCKETS manager (combinatorial codebook v2): the running list of
 * shared buckets (a bucket = a general action housing member codes), each
 * coder's fork Δ over them, push (double-confirm) / batch-pull, and snapshot
 * cutting. Combinatorial code DEFINITIONS (which buckets a code is an AND of)
 * are authored on the code page — this screen owns the bucket side.
 */
export default async function BucketsPage() {
  const codebook = await getOrCreateCodebook();
  const [ctx, tree, role] = await Promise.all([
    getCombinatorialContext(codebook.id),
    listCodebookTree(codebook.id),
    getMyRole(),
  ]);

  const codeOptions = toComboCodes(tree.codes);

  return (
    <BucketManager
      codebookId={codebook.id}
      buckets={ctx.buckets}
      defs={ctx.defs}
      latestSnapshotId={ctx.latestSnapshotId}
      codeOptions={codeOptions}
      readOnly={role === 'viewer'}
    />
  );
}

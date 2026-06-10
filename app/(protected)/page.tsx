import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import MatrixView from '@/components/matrix/MatrixView';

export default async function Home() {
  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);
  return <MatrixView tree={tree} />;
}

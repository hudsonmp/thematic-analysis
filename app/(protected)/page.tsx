import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { getCitation } from '@/app/actions/citations';
import MatrixView from '@/components/matrix/MatrixView';

/**
 * The scheme / matrix page. In Next 16 `searchParams` is a Promise and must be
 * awaited (reading it opts the page into dynamic rendering).
 *
 * Deductive coding ("code from citation"): when `?fromCitation=<id>` is present
 * we resolve that citation and hand it to MatrixView as `boundCitation`. The
 * matrix then renders a "Deriving codes from <paper>" banner and puts the
 * new-code form in bound mode (auto-link derived_from + default origin=a_priori,
 * persisting across successive creates). A stale/unknown id resolves to null, so
 * the page falls back to the ordinary unbound matrix rather than erroring.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);

  const raw = (await searchParams).fromCitation;
  const fromCitation = Array.isArray(raw) ? raw[0] : raw;
  const boundCitation = fromCitation ? await getCitation(fromCitation) : null;

  return <MatrixView tree={tree} boundCitation={boundCitation} />;
}

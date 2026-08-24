import { redirect } from 'next/navigation';
import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { getCitation } from '@/app/actions/citations';
import SchemeView from '@/components/codebook/SchemeView';

/**
 * The scheme / matrix page. In Next 16 `searchParams` is a Promise and must be
 * awaited (reading it opts the page into dynamic rendering).
 *
 * Deductive coding ("code from citation"): when `?fromCitation=<id>` is present
 * we resolve that citation and hand it through SchemeView to MatrixView as
 * `boundCitation`. The matrix then renders a "Deriving codes from <paper>" banner
 * and puts the new-code form in bound mode (auto-link derived_from + default
 * origin=a_priori, persisting across successive creates). A stale/unknown id
 * resolves to null, so the page falls back to the ordinary unbound matrix rather
 * than erroring.
 *
 * The page stays a Server Component: it fetches the tree + citation and passes
 * serializable props to SchemeView, the Client Component holding the Matrix |
 * Folders toggle (default Matrix, so this is non-disruptive).
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const query = await searchParams;

  // The admin console is a real route again (/admin, linked from the Codebook
  // menu for admins). Older `/?admin` links redirect there so there is exactly
  // one canonical location rather than two doors onto the same panel.
  if (query.admin !== undefined) redirect('/admin');

  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);

  const raw = query.fromCitation;
  const fromCitation = Array.isArray(raw) ? raw[0] : raw;
  const boundCitation = fromCitation ? await getCitation(fromCitation) : null;

  return <SchemeView tree={tree} boundCitation={boundCitation} />;
}

import { redirect } from 'next/navigation';
import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { getCombinatorialContext } from '@/app/actions/buckets';
import { getMyRole } from '@/lib/auth/roles';
import CodebookViews from './CodebookViews';

/**
 * The Codebook page (server). ONE surface for the whole instrument: the construct
 * tree, the codes placed on it, the scheme that defines a code, and the codes not
 * yet placed anywhere.
 *
 * Server Component: it resolves the active codebook and reads the whole codebook
 * tree ONCE — labels (the construct tree), codes (with their placements, facet
 * values and citations), facets (the SCHEME, which is what the New Code dialog
 * asks for — the dialog invents no fields), and the citation library (the
 * deductive-mode paper pin). The client shell switches between the two views over
 * that single load, so neither view refetches.
 *
 * Server Actions (create / attach / interpose / …) are invoked from client
 * handlers, never during client render; the page re-reads via router.refresh().
 */
export default async function CodebookPage() {
  // View mode / edit mode: the DOCUMENT (/codebook/view) is the view mode, this
  // canvas is the edit mode. Viewers only get the former — and the restriction is
  // not merely this redirect: their JWT is rejected by the restrictive RLS policies
  // and every codebook-mutating action checks requireEditor().
  const role = await getMyRole();
  if (role === 'viewer') redirect('/codebook/view');

  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);

  // Combinatorial context (v2) for the Buckets tab — non-fatal: a load failure
  // renders the page without that tab rather than breaking the codebook.
  let combinatorial: Awaited<ReturnType<typeof getCombinatorialContext>> | null = null;
  try {
    combinatorial = await getCombinatorialContext(cb.id);
  } catch {
    // Non-fatal.
  }

  return <CodebookViews tree={tree} combinatorial={combinatorial} />;
}

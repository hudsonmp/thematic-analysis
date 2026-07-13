import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
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
  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);

  return <CodebookViews tree={tree} />;
}

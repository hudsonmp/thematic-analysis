import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import CodebookViewDocument from './CodebookViewDocument';

/**
 * /codebook/view — the codebook as a READABLE DOCUMENT: every code as a nested list
 * with full anatomy, printable to PDF.
 *
 * Distinct from the /export page (which emits the LaTeX methods TABLE and JSON backup)
 * and from /codebook (the interactive canvas). This is the human artifact — what a
 * coder reads to learn the instrument and a reviewer reads to judge it.
 *
 * Server Component: reads the whole tree once and hands it to the client renderer,
 * which owns only the organizing-dimension switch and the print trigger.
 */
export default async function CodebookViewPage() {
  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);

  return (
    <CodebookViewDocument
      codebookName={tree.codebook.name}
      facets={tree.facets}
      codes={tree.codes}
      citations={tree.citations}
    />
  );
}

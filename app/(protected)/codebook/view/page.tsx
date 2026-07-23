import { getOrCreateCodebook, listCodebooks, listCodebookTree } from '@/app/actions/codebook';
import CodebookViewDocument from './CodebookViewDocument';

/**
 * /codebook/view — the codebook as a READABLE DOCUMENT: cover tree + spreadsheet,
 * printable to PDF.
 *
 * Distinct from the /export page (which emits the LaTeX methods TABLE and JSON backup)
 * and from /codebook (the interactive canvas). This is the human artifact — what a
 * coder reads to learn the instrument and a reviewer reads to judge it.
 *
 * WHICH codebook: `?codebook=<id>` selects one for THIS VIEW ONLY, defaulting to the
 * active (cookie) codebook. Deliberately not the cookie switcher — printing codebook B
 * must not silently change which codebook the next coding session writes to. The id is
 * validated against the shown study's codebooks (listCodebooks is study-scoped), so a
 * stale/foreign id falls back to the active one instead of leaking cross-study.
 *
 * Server Component: reads the whole tree once and hands it to the client renderer,
 * which owns the codebook/organizing switches and the print trigger.
 */
export default async function CodebookViewPage({
  searchParams,
}: {
  searchParams: Promise<{ codebook?: string }>;
}) {
  const { codebook: requested } = await searchParams;
  const [active, all] = await Promise.all([getOrCreateCodebook(), listCodebooks()]);
  const chosen = all.find((c) => c.id === requested) ?? active;
  const tree = await listCodebookTree(chosen.id);

  return (
    <CodebookViewDocument
      codebookName={tree.codebook.name}
      codebookId={chosen.id}
      codebooks={all.map((c) => ({ id: c.id, name: c.name }))}
      facets={tree.facets}
      codes={tree.codes}
      citations={tree.citations}
    />
  );
}

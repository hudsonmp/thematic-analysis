import { notFound } from 'next/navigation';
import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { listCodeVersions } from '@/app/actions/codes';
import { listComments } from '@/app/actions/comments';
import { getProtocolEpisodes } from '@/app/actions/protocol';
import CodeCard from '@/components/code/CodeCard';

/**
 * The code-anatomy page. Next 16: `params` is a Promise, so we await it. We
 * resolve the codebook, read its tree to locate the code (404 via notFound if
 * it isn't in this codebook), then fetch the per-code extras (full version
 * history, comment thread) and the study's protocol episodes for the exemplar
 * episode picker. Everything is handed to the client `CodeCard` as props — no
 * Server Actions are invoked during client render.
 */
export default async function CodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);
  const code = tree.codes.find((c) => c.id === id);
  if (!code) notFound();

  const [versions, comments, episodes] = await Promise.all([
    listCodeVersions(id),
    listComments(id),
    getProtocolEpisodes(),
  ]);

  return (
    <CodeCard
      code={code}
      facets={tree.facets}
      citations={tree.citations}
      versions={versions}
      comments={comments}
      episodes={episodes}
    />
  );
}

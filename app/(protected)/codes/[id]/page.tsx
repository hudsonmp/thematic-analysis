import { notFound } from 'next/navigation';
import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { getCombinatorialContext } from '@/app/actions/buckets';
import { listCodeVersions } from '@/app/actions/codes';
import { listComments } from '@/app/actions/comments';
import { getProtocolEpisodes } from '@/app/actions/protocol';
import { getMyRole } from '@/lib/auth/roles';
import CodeCard from '@/components/code/CodeCard';
import CombinatorialDef from '@/components/code/CombinatorialDef';

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

  const [versions, comments, episodes, role] = await Promise.all([
    listCodeVersions(id),
    listComments(id),
    getProtocolEpisodes(),
    getMyRole(),
  ]);

  // Combinatorial context (v2) for the definition editor — non-fatal, like the
  // session page: a load failure renders the page without the editor.
  let combinatorial: Awaited<ReturnType<typeof getCombinatorialContext>> | null = null;
  try {
    combinatorial = await getCombinatorialContext(cb.id);
  } catch {
    // Non-fatal.
  }

  const allCodes = tree.codes.map((c) => ({ id: c.id, mnemonic: c.mnemonic }));

  return (
    <>
      <CodeCard
        code={code}
        facets={tree.facets}
        citations={tree.citations}
        cbEpisodes={tree.episodes}
        cbLabels={tree.labels}
        versions={versions}
        comments={comments}
        episodes={episodes}
        // The @-mention candidates for the anatomy editor: the tree is already
        // in hand here, so the id+mnemonic pairs ride down as plain props.
        allCodes={allCodes}
      />
      {combinatorial && (
        <div className="mx-auto max-w-4xl px-6 pb-10">
          <CombinatorialDef
            codeId={id}
            items={combinatorial.defs[id] ?? []}
            buckets={combinatorial.buckets}
            allCodes={allCodes}
            readOnly={role === 'viewer'}
          />
        </div>
      )}
    </>
  );
}

import { getOrCreateCodebook } from '@/app/actions/codebook';
import { getActionSchema } from '@/app/actions/action-schema';
import { getMyRole } from '@/lib/auth/roles';
import ActionsWorkspace from '@/components/actions/ActionsWorkspace';

/**
 * /actions — define the MOVE and OBJECT vocabularies, any extra QUESTIONS, and
 * compose ACTIONS (= moves × objects) from them.
 *
 * Server Component: resolves the active codebook and loads the whole schema in
 * one pass, then hands it to the client workspace. The client calls Server
 * Actions from event handlers and `router.refresh()`es to re-run this loader.
 * Viewers get the same page read-only (the actions enforce this again).
 */
export default async function ActionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [cb, role, sp] = await Promise.all([getOrCreateCodebook(), getMyRole(), searchParams]);
  const schema = await getActionSchema(cb.id);
  const tab = typeof sp.tab === 'string' ? sp.tab : null;
  return (
    <ActionsWorkspace
      codebookId={cb.id}
      schema={schema}
      canEdit={role !== 'viewer'}
      initialTab={
        tab === 'moves' || tab === 'objects' || tab === 'roles' || tab === 'questions' || tab === 'actions'
          ? tab
          : 'moves'
      }
    />
  );
}

import { getOrCreateCodebook } from '@/app/actions/codebook';
import { getCodebookNotes } from '@/app/actions/notes';
import InstructionsEditor from '@/components/instructions/InstructionsEditor';

/**
 * The Instructions / notes page. A Server Component: it resolves the active
 * codebook (the same `getOrCreateCodebook` path as /labels and /episodes) and
 * loads that codebook's saved notes body, then hands both to the client
 * `InstructionsEditor`. The editor autosaves via the `saveCodebookNotes` Server
 * Action from its own debounce timer — no Server Actions run during client
 * render.
 */
export default async function InstructionsPage() {
  const cb = await getOrCreateCodebook();
  const body = await getCodebookNotes(cb.id);

  return <InstructionsEditor codebookId={cb.id} initialBody={body} />;
}

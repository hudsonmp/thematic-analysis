import { getSessionCloud } from '@/app/actions/sessions';
import { listAllAnnotations, listCanonical } from '@/app/actions/annotations';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import CompareView from '@/components/sessions/CompareView';

/**
 * The post-hoc, READ-ONLY multi-coder Compare tab (#21, Task 11). Next 16:
 * `params` is a Promise, so we await it.
 *
 * Methodological premise: coders code INDEPENDENTLY — the own-coding view at
 * `/sessions/[id]` shows ONLY your own annotations. THIS page is the separate
 * surface where you see how every coder coded the same session (the diff), which
 * supports negotiated agreement. It reads EVERY coder's annotations via
 * `listAllAnnotations` (the read-all RLS policy admits the cross-coder select)
 * and renders the per-segment coder×code matrix. It NEVER writes — independence
 * is preserved because coding lives entirely on the own-coding page.
 *
 * `getSessionCloud(id)` supplies the transcript segments (and 404s a missing id);
 * `listAllAnnotations(id)` supplies all coders' annotations + the distinct coder
 * list (the matrix columns); `listCanonical(id)` supplies the reconciled
 * (canonical) coding per segment — the authoritative set Task 12 lets a
 * reconciler accept codes into. Unlike Task 11 this page is NO LONGER strictly
 * read-only: the Canonical column carries the accept/clear reconciliation
 * controls. Independent per-coder coding still lives only on the own-coding page.
 */
export default async function ComparePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAuthUser();

  const [session, { annotations, coders }, canonical] = await Promise.all([
    getSessionCloud(id),
    listAllAnnotations(id),
    listCanonical(id),
  ]);

  return (
    <CompareView
      sessionId={session.id}
      versionId={session.versionId}
      pidLabel={session.pidLabel}
      segments={session.segments}
      annotations={annotations}
      coders={coders}
      canonical={canonical}
    />
  );
}

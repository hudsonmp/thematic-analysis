import { redirect } from 'next/navigation';
import { getOrCreateCodebook, listCodebookTree } from '@/app/actions/codebook';
import { getMyRole } from '@/lib/auth/roles';
import MergePanel, { type MergeCode } from '@/components/codebook/MergePanel';

/**
 * /codebook/merge — collapse duplicate codes into one survivor (server page).
 *
 * Server Component: resolves the codebook and reads the tree once (same load
 * path as /codebook and the session player), then hands the client panel a
 * projection of the LIVE codes. `listCodebookTree` returns EVERY code — its
 * cb_codes select carries no retired filter — so live-ness (retired_at null)
 * is applied here: a merge can only involve codes still in the working set,
 * and an already-merged code must not be absorbable twice.
 *
 * Editor-gated like /codebook (viewers are redirected to the readable
 * document); the mergeCodes action re-checks requireEditor, and the DB
 * function is SECURITY INVOKER so RLS enforces it a third time.
 */
export default async function CodeMergePage({
  searchParams,
}: {
  /** Next 16: searchParams is a Promise. `ids` carries the codebook tree's
   *  merge-mode selection (comma-separated, click order). */
  searchParams: Promise<{ ids?: string }>;
}) {
  const role = await getMyRole();
  if (role === 'viewer') redirect('/codebook/view');

  const cb = await getOrCreateCodebook();
  const tree = await listCodebookTree(cb.id);
  const live = tree.codes.filter((c) => c.retired_at === null);

  // Pre-selection from the tree's merge mode, validated against LIVE codes so a
  // stale/forged id can never seed the panel; order (= click order) preserved.
  const { ids } = await searchParams;
  const liveIds = new Set(live.map((c) => c.id));
  const initialSelectedIds = (ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && liveIds.has(s));

  // The panel's projection: identity + origin + the current version's anatomy.
  // The jsonb columns pass through as-is; the pure merge lib coerces them.
  const codes: MergeCode[] = live.map((c) => ({
    id: c.id,
    mnemonic: c.mnemonic,
    origin: c.origin,
    current: c.current
      ? {
          definition: c.current.definition,
          include_if: c.current.include_if,
          exclude_if: c.current.exclude_if,
          exemplars: c.current.exemplars,
          disconfirming_pattern: c.current.disconfirming_pattern,
        }
      : null,
  }));

  // The @-mention candidate pool (the panel excludes the codes being merged).
  const allCodes = live.map((c) => ({ id: c.id, mnemonic: c.mnemonic }));

  return (
    <MergePanel codes={codes} allCodes={allCodes} initialSelectedIds={initialSelectedIds} />
  );
}

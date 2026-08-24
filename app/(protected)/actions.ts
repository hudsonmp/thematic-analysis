'use server';

import { redirect } from 'next/navigation';
import { createCode } from '@/app/actions/codes';
import type { CodeOrigin } from '@/app/actions/codes';
import { linkCitation } from '@/app/actions/citations';

export type NewCodeState = { error?: string };

const ORIGINS: readonly CodeOrigin[] = ['a_priori', 'pilot', 'emergent'];

function isOrigin(value: string): value is CodeOrigin {
  return (ORIGINS as readonly string[]).includes(value);
}

/**
 * `useActionState` wrapper for the matrix's inline "New code" form. Creates a
 * code (version 1 carries only the one-line definition; the full anatomy editor
 * lands in a later task), optionally links one or more citations picked in the
 * form (Feature #9), then redirects to the new code's anatomy page. On
 * validation failure it returns `{ error }` so the client form can surface it.
 *
 * Citation ids arrive as repeated `citationIds` form fields (the picker emits a
 * hidden input per picked citation). After `createCode` returns the new id we
 * `linkCitation(newId, id, 'derived_from')` for each — sequentially so one bad
 * id surfaces a clean error rather than an unhandled rejection. A code created
 * with NO citations picked links nothing (the create still succeeds).
 *
 * Deductive "code from citation" mode: when the form carries a `fromCitation`
 * field (the matrix bound-mode banner), the bound paper id is also present in
 * `citationIds` (so the derived_from link happens through the normal path — no
 * double-link), and origin defaults to `a_priori`. On success we redirect back
 * to `/?fromCitation=<id>` instead of the new code's page, so the binding
 * PERSISTS and the researcher can derive several a priori codes in a row from
 * the same paper until they exit. Out of bound mode, we redirect to the new
 * code's anatomy page as before.
 *
 * `redirect` throws a framework control-flow signal, so nothing after it runs;
 * the trailing `return {}` exists only to satisfy the `useActionState` return
 * contract on the (unreachable) success path.
 */
export async function createCodeAction(
  _prev: NewCodeState,
  formData: FormData,
): Promise<NewCodeState> {
  const codebookId = (formData.get('codebookId') ?? '').toString().trim();
  const mnemonic = (formData.get('mnemonic') ?? '').toString().trim();
  const originRaw = (formData.get('origin') ?? '').toString().trim();
  const definition = (formData.get('definition') ?? '').toString().trim();
  // Bound "code from citation" mode marker (empty string when unbound).
  const fromCitation = (formData.get('fromCitation') ?? '').toString().trim();
  // Repeated `citationIds` fields → de-duped list of citation ids to link.
  const citationIds = [
    ...new Set(
      formData
        .getAll('citationIds')
        .map((v) => v.toString().trim())
        .filter(Boolean),
    ),
  ];

  if (!codebookId) return { error: 'Missing codebook.' };
  if (!mnemonic) return { error: 'A slug (mnemonic) is required.' };
  if (!definition) return { error: 'A one-line definition is required.' };
  if (!isOrigin(originRaw)) return { error: 'Invalid origin.' };

  let newId: string;
  try {
    newId = await createCode({
      codebookId,
      mnemonic,
      origin: originRaw,
      version: { definition, include_if: [], exclude_if: [], exemplars: [] },
    });
    for (const citationId of citationIds) {
      await linkCitation(newId, citationId, 'derived_from');
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to create code.' };
  }

  // Bound mode: stay on the paper so the next create is still bound (persist the
  // binding). Otherwise go to the new code's anatomy page.
  if (fromCitation) {
    redirect(`/?fromCitation=${encodeURIComponent(fromCitation)}`);
  }
  redirect(`/codes/${newId}`);
}

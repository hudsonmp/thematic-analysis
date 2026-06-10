'use server';

import { redirect } from 'next/navigation';
import { createCode } from '@/app/actions/codes';
import type { CodeOrigin } from '@/app/actions/codes';
import { exportCodebookJson } from '@/lib/export/json';

/**
 * Server-action shim over `exportCodebookJson` for the export page's JSON
 * download. `lib/export/json.ts` imports `server-only` (it pulls the
 * `'use server'` codebook action and the service-role client), so it CANNOT be
 * imported into the Client `ExportView`. Wrapping it in a `'use server'`
 * function lets the client invoke it over the action boundary and download the
 * returned string. (The LaTeX renderer is pure and runs client-side directly.)
 */
export async function exportCodebookJsonAction(codebookId: string): Promise<string> {
  return exportCodebookJson(codebookId);
}

export type NewCodeState = { error?: string };

const ORIGINS: readonly CodeOrigin[] = ['a_priori', 'pilot', 'emergent'];

function isOrigin(value: string): value is CodeOrigin {
  return (ORIGINS as readonly string[]).includes(value);
}

/**
 * `useActionState` wrapper for the matrix's inline "New code" form. Creates a
 * code (version 1 carries only the one-line definition; the full anatomy editor
 * lands in a later task) and redirects to the new code's anatomy page. On
 * validation failure it returns `{ error }` so the client form can surface it.
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
  const name = (formData.get('name') ?? '').toString().trim();
  const originRaw = (formData.get('origin') ?? '').toString().trim();
  const definition = (formData.get('definition') ?? '').toString().trim();

  if (!codebookId) return { error: 'Missing codebook.' };
  if (!mnemonic) return { error: 'Mnemonic is required.' };
  if (!name) return { error: 'Name is required.' };
  if (!definition) return { error: 'A one-line definition is required.' };
  if (!isOrigin(originRaw)) return { error: 'Invalid origin.' };

  let newId: string;
  try {
    newId = await createCode({
      codebookId,
      mnemonic,
      name,
      origin: originRaw,
      version: { definition, include_if: [], exclude_if: [], exemplars: [] },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to create code.' };
  }

  redirect(`/codes/${newId}`);
}

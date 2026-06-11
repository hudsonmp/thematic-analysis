'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';

// ---------------------------------------------------------------------------
// Codebook notes — the researcher's OWN free-form "Instructions" document.
//
// One plain-text / markdown body PER codebook (cb_codebook_notes, a 1:1 row
// keyed on codebook_id, migration 23). This is a running scratchpad the
// researcher autosaves as they work ("how to do stuff" — conventions, reminders,
// decisions), distinct from the formal protocol/anatomy/scheme surfaces. No
// versioning, no structure: just get the body and upsert the body.
//
// Writes go through `cbFrom` (service role; cb_codebook_notes' RLS is open to
// `authenticated`), mirroring labels.ts / flag-types.ts.
// ---------------------------------------------------------------------------

/**
 * Read a codebook's notes body. Returns the saved `body`, or '' when the row
 * does not exist yet (no notes have ever been written) — the editor renders an
 * empty document in that case, and the first save creates the row.
 */
export async function getCodebookNotes(codebookId: string): Promise<string> {
  await requireAuthUser();
  const { data, error } = await cbFrom('cb_codebook_notes')
    .select('body')
    .eq('codebook_id', codebookId)
    .maybeSingle();
  if (error) throw new Error(`getCodebookNotes failed: ${error.message}`);
  return data?.body ?? '';
}

/**
 * Save a codebook's notes body (autosave). Upserts the 1:1 row on its
 * `codebook_id` PK — inserts on first save, overwrites on subsequent ones — and
 * bumps `updated_at` so the UI can surface a "saved" timestamp. Returns the new
 * `updated_at` so the client can show when it last persisted.
 */
export async function saveCodebookNotes(
  codebookId: string,
  body: string,
): Promise<{ updated_at: string }> {
  await requireAuthUser();
  const { data, error } = await cbFrom('cb_codebook_notes')
    .upsert(
      { codebook_id: codebookId, body, updated_at: new Date().toISOString() },
      { onConflict: 'codebook_id' },
    )
    .select('updated_at')
    .single();
  if (error || !data) {
    throw new Error(`saveCodebookNotes failed: ${error?.message ?? 'no row returned'}`);
  }
  return { updated_at: data.updated_at };
}

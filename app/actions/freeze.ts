'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { listCodebookTree } from '@/app/actions/codebook';
import { buildSnapshot } from '@/lib/export/snapshot';
import type { Json, Tables } from '@/lib/types/cb-db';
import { requireEditor } from '@/lib/auth/roles';

type CodebookVersion = Tables<'cb_codebook_versions'>;

/**
 * Freeze the current codebook into an immutable version row.
 *
 * Reads the live aggregate (`listCodebookTree`), assembles the canonical
 * snapshot (`buildSnapshot` — PURE, emits `frozen_at: null`), then the ACTION
 * stamps the real freeze time. Keeping the clock out of the pure builder is what
 * makes the snapshot deterministic/unit-testable; the action is the single place
 * a wall-clock value enters. The stamped snapshot is the source of truth for
 * downstream reliability runs and exports, decoupled from later live edits.
 */
export async function freezeCodebook({
  codebookId,
  label,
  calibrationRound,
  note,
  frozenBy,
}: {
  codebookId: string;
  label: string;
  calibrationRound?: number;
  note?: string;
  frozenBy?: string;
}): Promise<CodebookVersion> {
  await requireEditor(); // viewers are read-only
  const tree = await listCodebookTree(codebookId);
  const snapshot = buildSnapshot(tree);
  const frozenAt = new Date().toISOString();
  snapshot.frozen_at = frozenAt;

  const res = await cbFrom('cb_codebook_versions')
    .insert({
      codebook_id: codebookId,
      label,
      snapshot: snapshot as unknown as Json,
      frozen_at: frozenAt,
      frozen_by: frozenBy ?? null,
      note: note ?? null,
      calibration_round: calibrationRound ?? null,
    })
    .select('*')
    .single();
  if (res.error || !res.data) {
    throw new Error(`freezeCodebook failed: ${res.error?.message ?? 'no row returned'}`);
  }
  return res.data;
}

/** List a codebook's frozen versions, newest first. */
export async function listFrozenVersions(codebookId: string): Promise<CodebookVersion[]> {
  const res = await cbFrom('cb_codebook_versions')
    .select('*')
    .eq('codebook_id', codebookId)
    .order('frozen_at', { ascending: false });
  if (res.error) {
    throw new Error(`listFrozenVersions failed: ${res.error.message}`);
  }
  return res.data ?? [];
}

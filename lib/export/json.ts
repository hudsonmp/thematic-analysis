import 'server-only';
import { listCodebookTree } from '@/app/actions/codebook';
import { buildSnapshot } from '@/lib/export/snapshot';

/**
 * Export a codebook as pretty-printed JSON (Task 12, Part E).
 *
 * Reuses the PURE `buildSnapshot` over the live aggregate, so the export shape is
 * identical to the frozen-version snapshot — minus the freeze stamp: this is a
 * live read, so `frozen_at` stays null (it is not a frozen artifact). Returns the
 * serialized string; the caller decides how to deliver it (download, copy, etc.).
 */
export async function exportCodebookJson(codebookId: string): Promise<string> {
  const tree = await listCodebookTree(codebookId);
  const snapshot = buildSnapshot(tree);
  return JSON.stringify(snapshot, null, 2);
}

'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { parseLabelTable } from '@/lib/reliability/parse-labels';
import {
  percentAgreement,
  cohenKappa,
  pabak,
  krippendorffAlphaNominal,
  prevalenceIndex,
  biasIndex,
  landisKochBand,
  isMisCarved,
  type KappaBand,
  type LabelPair,
} from '@/lib/reliability/stats';
import type { Json, Tables, TablesInsert } from '@/lib/types/cb-db';

export type ReliabilityScope = 'overall' | 'facet_value' | 'code';

type ReliabilityRun = Tables<'cb_reliability_runs'>;

export type ReliabilityResult = {
  runId: string;
  percentAgreement: number;
  cohenKappa: number;
  pabak: number | null;
  alpha: number;
  prevalenceIndex: number | null;
  biasIndex: number | null;
  band: KappaBand;
  misCarved: boolean;
  degenerate: boolean;
};

/** Distinct category count across both coders. A single distinct category means
 *  there was no possible disagreement to observe — Pe collapses to 1 and the
 *  kappa convention returns 1, which would read as "perfect" rather than the
 *  truth ("undefined / uninformative"). We surface that as `degenerate`. */
function distinctCategoryCount(pairs: LabelPair[]): number {
  return new Set(pairs.flat()).size;
}

/**
 * Compute the full reliability stack for a pasted two-coder label table and
 * persist a `cb_reliability_runs` row.
 *
 * Degenerate-input guard (carry-forward): if the label set has only ONE distinct
 * category, the run is flagged `degenerate: true` and a note is recorded —
 * `cohenKappa` returns 1 when Pe=1, which would otherwise be misread as perfect
 * agreement. The numbers are still persisted (with the note) so the run is
 * auditable, but the flag tells the UI/caller not to trust the kappa.
 *
 * The scope CHECK constraint (migration 04) requires:
 *   overall      -> both scope_*_id null
 *   facet_value  -> scope_facet_value_id set, scope_code_id null
 *   code         -> scope_code_id set, scope_facet_value_id null
 * We set exactly the column the scope demands and leave the other null.
 */
export async function computeReliability({
  codebookId,
  codebookVersionId,
  scope,
  scopeFacetValueId,
  scopeCodeId,
  labelTableText,
  nCoders,
  note,
}: {
  codebookId: string;
  codebookVersionId?: string;
  scope: ReliabilityScope;
  scopeFacetValueId?: string;
  scopeCodeId?: string;
  labelTableText: string;
  nCoders?: number;
  note?: string;
}): Promise<ReliabilityResult> {
  const { pairs } = parseLabelTable(labelTableText);
  if (pairs.length === 0) {
    throw new Error(
      'computeReliability: no label pairs parsed from input (expected rows of "unit,labelA,labelB" or "labelA,labelB").',
    );
  }

  const degenerate = distinctCategoryCount(pairs) < 2;

  const po = percentAgreement(pairs);
  const kappa = cohenKappa(pairs);
  const pabakValue = pabak(pairs);
  const alpha = krippendorffAlphaNominal(pairs);
  const prevalence = prevalenceIndex(pairs);
  const bias = biasIndex(pairs);
  const band = landisKochBand(kappa);
  const misCarved = isMisCarved(kappa);

  const degenerateNote = 'single-category input — kappa undefined';
  const persistedNote = degenerate
    ? note
      ? `${note} | ${degenerateNote}`
      : degenerateNote
    : note ?? null;

  const insert: TablesInsert<'cb_reliability_runs'> = {
    codebook_id: codebookId,
    codebook_version_id: codebookVersionId ?? null,
    scope,
    scope_facet_value_id: scope === 'facet_value' ? scopeFacetValueId ?? null : null,
    scope_code_id: scope === 'code' ? scopeCodeId ?? null : null,
    n_units: pairs.length,
    n_coders: nCoders ?? 2,
    percent_agreement: po,
    cohen_kappa: kappa,
    pabak: pabakValue,
    krippendorff_alpha: alpha,
    prevalence_index: prevalence,
    bias_index: bias,
    raw_labels: pairs as unknown as Json,
    note: persistedNote,
  };

  const res = await cbFrom('cb_reliability_runs').insert(insert).select('id').single();
  if (res.error || !res.data) {
    throw new Error(
      `computeReliability persist failed: ${res.error?.message ?? 'no row returned'}`,
    );
  }

  return {
    runId: res.data.id,
    percentAgreement: po,
    cohenKappa: kappa,
    pabak: pabakValue,
    alpha,
    prevalenceIndex: prevalence,
    biasIndex: bias,
    band,
    misCarved,
    degenerate,
  };
}

/** Dismiss a mis-carved flag with a written rationale (stored in dismissed_note). */
export async function dismissMisCarved(runId: string, rationale: string): Promise<void> {
  const { error } = await cbFrom('cb_reliability_runs')
    .update({ dismissed_note: rationale })
    .eq('id', runId);
  if (error) throw new Error(`dismissMisCarved failed: ${error.message}`);
}

/** List a codebook's reliability runs, newest first. */
export async function listReliabilityRuns(codebookId: string): Promise<ReliabilityRun[]> {
  const res = await cbFrom('cb_reliability_runs')
    .select('*')
    .eq('codebook_id', codebookId)
    .order('computed_at', { ascending: false });
  if (res.error) {
    throw new Error(`listReliabilityRuns failed: ${res.error.message}`);
  }
  return res.data ?? [];
}

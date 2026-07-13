import { describe, expect, it } from 'vitest';
import { EVAL_TABLES, assertEvalTable } from '@/lib/supabase/eval-guard-core';

describe('assertEvalTable', () => {
  it('accepts every allowlisted eval table', () => {
    for (const t of EVAL_TABLES) expect(() => assertEvalTable(t)).not.toThrow();
  });

  it('accepts all six eval_* tables by name', () => {
    for (const t of [
      'eval_artifacts',
      'eval_prompt_variants',
      'eval_few_shot_sets',
      'eval_annotations',
      'eval_runs',
      'eval_verdicts',
    ]) {
      expect(() => assertEvalTable(t)).not.toThrow();
    }
  });

  it('rejects cb_ tables, study tables, and unknown names', () => {
    for (const t of [
      'cb_codes',
      'study_snapshots',
      'users',
      'llm_prompts',
      'evalx_runs',
      '',
    ]) {
      expect(() => assertEvalTable(t)).toThrow(/not an eval table/i);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  STUDY_TABLES,
  assertStudyTable,
  selectOnly,
} from '@/lib/supabase/study-guard-core';

describe('assertStudyTable', () => {
  it('accepts every allowlisted study table', () => {
    for (const t of STUDY_TABLES) expect(() => assertStudyTable(t)).not.toThrow();
  });
  it('rejects cb_ tables, eval tables, and unknown names', () => {
    for (const t of ['cb_codes', 'cb_sessions', 'eval_runs', 'auth.users', 'studiesx', '']) {
      expect(() => assertStudyTable(t)).toThrow(/not a study table/i);
    }
  });
});

describe('selectOnly', () => {
  const stub = {
    select: (cols: string) => `selected:${cols}`,
    insert: () => 'wrote',
    update: () => 'wrote',
    upsert: () => 'wrote',
    delete: () => 'wrote',
    url: 'https://example.test',
  };

  it('passes read members through untouched', () => {
    const guarded = selectOnly(stub);
    expect(guarded.select('id')).toBe('selected:id');
    expect(guarded.url).toBe('https://example.test');
  });

  it('throws on every write verb, at ACCESS time (before any call)', () => {
    const guarded = selectOnly(stub) as unknown as Record<string, unknown>;
    for (const verb of ['insert', 'update', 'upsert', 'delete']) {
      expect(() => guarded[verb]).toThrow(/read-only/i);
    }
  });
});

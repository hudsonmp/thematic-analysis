import { describe, it, expect } from 'vitest';
import {
  EpisodeRef,
  Exemplar,
  BulletList,
  CodeVersionInput,
} from '@/lib/types/contracts';

describe('EpisodeRef', () => {
  it('accepts a valid phase + optional span', () => {
    const r = EpisodeRef.safeParse({
      module_id: 'm1',
      scenario_idx: 0,
      phase: 'ponder',
      span: [3, 12],
    });
    expect(r.success).toBe(true);
  });

  it('accepts without optional span', () => {
    const r = EpisodeRef.safeParse({
      module_id: 'm1',
      scenario_idx: 2,
      phase: 'initial',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a bad phase value', () => {
    const r = EpisodeRef.safeParse({
      module_id: 'm1',
      scenario_idx: 0,
      phase: 'brainstorm',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-integer scenario_idx', () => {
    const r = EpisodeRef.safeParse({
      module_id: 'm1',
      scenario_idx: 1.5,
      phase: 'read',
    });
    expect(r.success).toBe(false);
  });
});

describe('Exemplar', () => {
  it('parses a valid exemplar without episode_ref', () => {
    const r = Exemplar.safeParse({ text: 'student paused before revising' });
    expect(r.success).toBe(true);
  });

  it('parses a valid exemplar with episode_ref', () => {
    const r = Exemplar.safeParse({
      text: 'student paused before revising',
      source_pid: 'P07',
      episode_ref: {
        module_id: 'm2',
        scenario_idx: 1,
        phase: 'revise',
        span: [0, 40],
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty exemplar text', () => {
    const r = Exemplar.safeParse({ text: '' });
    expect(r.success).toBe(false);
  });

  it('rejects an exemplar whose episode_ref has a bad phase', () => {
    const r = Exemplar.safeParse({
      text: 'x',
      episode_ref: { module_id: 'm1', scenario_idx: 0, phase: 'nope' },
    });
    expect(r.success).toBe(false);
  });
});

describe('BulletList', () => {
  it('accepts an array of strings', () => {
    const r = BulletList.safeParse(['a', 'b', 'c']);
    expect(r.success).toBe(true);
  });

  it('rejects an array containing non-strings', () => {
    const r = BulletList.safeParse(['a', 2]);
    expect(r.success).toBe(false);
  });
});

describe('CodeVersionInput', () => {
  const valid = {
    definition: 'A moment of self-directed requirement discovery.',
    include_if: ['student names a missing requirement', 'student writes a test'],
    exclude_if: ['student copies AI output verbatim'],
    exemplars: [
      {
        text: 'I should check what happens with an empty list',
        source_pid: 'P01',
        episode_ref: { module_id: 'm1', scenario_idx: 0, phase: 'ponder' },
      },
    ],
    disconfirming_pattern: 'student defers entirely to the model',
    prediction: 'testing scaffolds requirement specification',
    prediction_falsifier: 'no change in requirement-naming after testing',
    change_note: 'split from broader help-seeking code',
  };

  it('parses a fully populated valid input', () => {
    const r = CodeVersionInput.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it('parses with only required fields', () => {
    const r = CodeVersionInput.safeParse({
      definition: 'minimal',
      include_if: [],
      exclude_if: [],
      exemplars: [],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty definition', () => {
    const r = CodeVersionInput.safeParse({ ...valid, definition: '' });
    expect(r.success).toBe(false);
  });

  it('accepts valid include_if / exclude_if string arrays', () => {
    const r = CodeVersionInput.safeParse({
      ...valid,
      include_if: ['only this'],
      exclude_if: ['not that'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects when include_if is not a string array', () => {
    const r = CodeVersionInput.safeParse({ ...valid, include_if: [1, 2] });
    expect(r.success).toBe(false);
  });

  it('rejects when an exemplar is invalid', () => {
    const r = CodeVersionInput.safeParse({
      ...valid,
      exemplars: [{ text: '' }],
    });
    expect(r.success).toBe(false);
  });
});

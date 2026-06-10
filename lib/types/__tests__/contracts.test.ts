import { describe, it, expect } from 'vitest';
import {
  EpisodeRef,
  RecordingRef,
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

describe('RecordingRef', () => {
  const valid = {
    kind: 'recording' as const,
    user_id: 'u1',
    study_id: 's1',
    pid: '651',
    span: [7180, 17900] as [number, number],
    segment_idxs: [2, 3],
  };

  it('accepts a fully populated recording ref', () => {
    expect(RecordingRef.safeParse(valid).success).toBe(true);
  });

  it('accepts null user_id / study_id (unresolved participant)', () => {
    const r = RecordingRef.safeParse({ ...valid, user_id: null, study_id: null });
    expect(r.success).toBe(true);
  });

  it('accepts without optional segment_idxs', () => {
    const { segment_idxs, ...rest } = valid;
    void segment_idxs;
    expect(RecordingRef.safeParse(rest).success).toBe(true);
  });

  it('rejects a wrong kind literal', () => {
    expect(RecordingRef.safeParse({ ...valid, kind: 'episode' }).success).toBe(false);
  });

  it('rejects a span that is not a 2-tuple', () => {
    expect(RecordingRef.safeParse({ ...valid, span: [1, 2, 3] }).success).toBe(false);
  });

  it('rejects non-integer segment_idxs', () => {
    expect(RecordingRef.safeParse({ ...valid, segment_idxs: [1.5] }).success).toBe(false);
  });

  it('rejects a missing pid', () => {
    const { pid, ...rest } = valid;
    void pid;
    expect(RecordingRef.safeParse(rest).success).toBe(false);
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

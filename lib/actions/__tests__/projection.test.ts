import { describe, expect, it } from 'vitest';
import { codingDetail, type ActionLite, type CodingSnapshotRow } from '../projection';

/**
 * A coding is a COMPLETED CODING ACT: what this coder attached to this span at
 * the moment they attached it. The reusable action it points at is a shortcut
 * for entering that judgement, not a live definition of it — so editing the
 * action later must NEVER rewrite what an existing coding says.
 */

const TRACE_AS_CODED: CodingSnapshotRow = {
  id: 'coding-1',
  actionId: 'act-trace',
  actionName: 'Trace',
  moveIds: ['mv-trace'],
  objectIds: ['ob-spec'],
  objectRoles: { 'ob-spec': 'ro-source' },
  answers: [{ questionId: 'q-1', optionId: 'opt-explicit', freeText: null }],
};

/** The SAME action after another editor rewrote it out from under the coding. */
const TRACE_AFTER_EDIT: ActionLite = {
  id: 'act-trace',
  name: 'Trace (revised)',
  moveIds: ['mv-trace', 'mv-verify'],
  objectIds: ['ob-code'],
  objectRoles: {},
  answers: [{ questionId: 'q-1', optionId: 'opt-implicit', freeText: null }],
};

const QUESTIONS = [
  {
    id: 'q-1',
    prompt: 'How explicit?',
    kind: 'multiple_choice' as const,
    required: false,
    options: [
      { id: 'opt-explicit', label: 'Explicit' },
      { id: 'opt-implicit', label: 'Implicit' },
    ],
  },
];

describe('codingDetail', () => {
  it('renders the composition snapshotted at coding time, not the action current one', () => {
    const { detail } = codingDetail(TRACE_AS_CODED, [TRACE_AFTER_EDIT], QUESTIONS);

    expect(detail.moveIds).toEqual(['mv-trace']);
    expect(detail.objectIds).toEqual(['ob-spec']);
    expect(detail.objectRoles).toEqual({ 'ob-spec': 'ro-source' });
    expect(detail.answers).toEqual([{ questionId: 'q-1', optionId: 'opt-explicit', freeText: null }]);
  });

  it('reports drift when the action has been edited away from the snapshot', () => {
    const { drifted } = codingDetail(TRACE_AS_CODED, [TRACE_AFTER_EDIT], QUESTIONS);

    expect(drifted).toBe(true);
  });

  it('reports no drift when the action still matches the snapshot', () => {
    const unchanged: ActionLite = {
      id: 'act-trace',
      name: 'Trace',
      moveIds: ['mv-trace'],
      objectIds: ['ob-spec'],
      objectRoles: { 'ob-spec': 'ro-source' },
      answers: [{ questionId: 'q-1', optionId: 'opt-explicit', freeText: null }],
    };

    const { drifted } = codingDetail(TRACE_AS_CODED, [unchanged], QUESTIONS);

    expect(drifted).toBe(false);
  });

  it('never reports drift for an ad hoc coding, which points at no action', () => {
    const adHoc: CodingSnapshotRow = { ...TRACE_AS_CODED, actionId: null, actionName: null };

    const { detail, drifted } = codingDetail(adHoc, [TRACE_AFTER_EDIT], QUESTIONS);

    expect(drifted).toBe(false);
    expect(detail.moveIds).toEqual(['mv-trace']);
  });

  it('keeps the snapshot when the action was deleted out from under the coding', () => {
    const { detail, drifted } = codingDetail(TRACE_AS_CODED, [], QUESTIONS);

    expect(detail.actionName).toBe('Trace');
    expect(detail.moveIds).toEqual(['mv-trace']);
    expect(drifted).toBe(false);
  });

  it('reports drift when only the action name changed', () => {
    const renamed: ActionLite = {
      id: 'act-trace',
      name: 'Trace (renamed)',
      moveIds: ['mv-trace'],
      objectIds: ['ob-spec'],
      objectRoles: { 'ob-spec': 'ro-source' },
      answers: [{ questionId: 'q-1', optionId: 'opt-explicit', freeText: null }],
    };

    const { detail, drifted } = codingDetail(TRACE_AS_CODED, [renamed], QUESTIONS);

    expect(detail.actionName).toBe('Trace');
    expect(drifted).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { diffFingerprints, type StudyFingerprint } from '@/lib/eval/audit-core';

describe('diffFingerprints', () => {
  it('returns [] when fingerprints are identical', () => {
    const fp: StudyFingerprint = { studies: 3, users: 41, study_snapshots: 172 };
    expect(diffFingerprints(fp, { ...fp })).toEqual([]);
    expect(diffFingerprints({}, {})).toEqual([]);
  });

  it('returns [] when a table failed to count on BOTH sides (-1 == -1)', () => {
    // The documented residual of the -1 sentinel: two failed counts compare
    // equal and cannot prove absence of drift. The diff treats them as a match
    // by design — flagging every transient count failure as "drift" would
    // train callers to ignore the audit.
    expect(diffFingerprints({ users: -1 }, { users: -1 })).toEqual([]);
  });

  it('reports a changed count as "table: before -> after"', () => {
    expect(
      diffFingerprints({ study_snapshots: 172 }, { study_snapshots: 173 }),
    ).toEqual(['study_snapshots: 172 -> 173']);
  });

  it('reports a count that FAILED on one side (-1 vs real) as drift, not a match', () => {
    expect(diffFingerprints({ users: 41 }, { users: -1 })).toEqual([
      'users: 41 -> -1',
    ]);
  });

  it('reports a table present before but missing after', () => {
    expect(diffFingerprints({ users: 41 }, {})).toEqual([
      'users: present before, missing after',
    ]);
  });

  it('reports a table only present after', () => {
    expect(diffFingerprints({}, { evalx: 5 })).toEqual([
      'evalx: absent before, present after',
    ]);
  });

  it('reports multiple drifts sorted deterministically by table name', () => {
    // Keys deliberately inserted out of order on both sides: the output order
    // must come from the diff (sorted union of table names), not from object
    // insertion order.
    const before: StudyFingerprint = {
      users: 41,
      study_snapshots: 172,
      onboarding_fields: 9,
    };
    const after: StudyFingerprint = {
      evalx: 5,
      study_snapshots: 173,
      users: 41,
    };
    expect(diffFingerprints(before, after)).toEqual([
      'evalx: absent before, present after',
      'onboarding_fields: present before, missing after',
      'study_snapshots: 172 -> 173',
    ]);
  });
});

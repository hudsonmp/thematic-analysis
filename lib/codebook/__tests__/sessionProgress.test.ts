import { describe, expect, it } from 'vitest';
import {
  coderStatusFromRow,
  displayStatus,
  statusLabel,
} from '@/lib/codebook/sessionProgress';

describe('displayStatus', () => {
  it('reconciliation OVERRIDES the coder\'s own status', () => {
    // Reconciliation is a property of the SESSION — the team has moved past independent
    // coding — so it must win over any individual's stale per-coder state.
    expect(displayStatus('individual_coding', '2026-07-15T00:00:00Z')).toBe('reconciliation');
    expect(displayStatus('not_started', '2026-07-15T00:00:00Z')).toBe('reconciliation');
  });

  it('is the coder\'s own status when the session is NOT in reconciliation', () => {
    expect(displayStatus('in_progress', null)).toBe('in_progress');
    expect(displayStatus('not_started', null)).toBe('not_started');
  });
});

describe('coderStatusFromRow', () => {
  it('treats an ABSENT row as not_started', () => {
    // Absence, not a stored value, is not_started — so a coder who never touched a
    // session has no row and no obligation to have one.
    expect(coderStatusFromRow(null)).toBe('not_started');
    expect(coderStatusFromRow(undefined)).toBe('not_started');
  });

  it('reads in_progress and individual_coding from a present row', () => {
    expect(coderStatusFromRow({ status: 'in_progress' })).toBe('in_progress');
    expect(coderStatusFromRow({ status: 'individual_coding' })).toBe('individual_coding');
  });

  it('degrades an unknown status to individual_coding ONLY because a row exists', () => {
    // A present row means the coder engaged; a corrupt status value should not silently
    // become not_started and erase that fact.
    expect(coderStatusFromRow({ status: 'garbage' })).toBe('individual_coding');
  });
});

describe('statusLabel', () => {
  it('gives human labels for all four display states', () => {
    expect(statusLabel('not_started')).toBe('Not Started');
    expect(statusLabel('in_progress')).toBe('In Progress');
    expect(statusLabel('individual_coding')).toBe('Individual Coding');
    expect(statusLabel('reconciliation')).toBe('Reconciliation');
  });
});

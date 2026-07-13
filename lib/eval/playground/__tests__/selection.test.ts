import { describe, expect, it } from 'vitest';
import type { ProgressionParticipant } from '@/app/actions/progression';
import {
  cohortKey,
  cohortSelectionState,
  deselectAll,
  deselectCohort,
  groupByCohort,
  orderCohorts,
  selectAll,
  selectCohort,
  toggle,
} from '../selection';

// Minimal participant factory — selection logic only touches pid + cohort; the
// stepCount / sessionId fields are irrelevant here (they live on the real
// ProgressionParticipant but never influence set-ops).
function p(pid: string, cohort: string | null): ProgressionParticipant {
  return { pid, cohort, sessionId: null, stepCount: 5 };
}

const PARTICIPANTS: ProgressionParticipant[] = [
  p('a', 'pilot'),
  p('b', 'study'),
  p('c', 'study'),
  p('d', null),
];

describe('cohortKey', () => {
  it('passes a real cohort through unchanged', () => {
    expect(cohortKey('pilot')).toBe('pilot');
  });
  it('maps null to a sentinel that sorts last (high code point, not "~")', () => {
    // The key for null must sort AFTER any real cohort under localeCompare.
    expect(cohortKey(null).localeCompare('study')).toBeGreaterThan(0);
    expect(cohortKey(null).localeCompare('zzzzz')).toBeGreaterThan(0);
  });
});

describe('orderCohorts', () => {
  it('orders pilot, study, then null LAST', () => {
    expect(orderCohorts(['study', null, 'pilot'])).toEqual(['pilot', 'study', null]);
  });
  it('deduplicates', () => {
    expect(orderCohorts(['study', 'study', 'pilot', 'pilot'])).toEqual(['pilot', 'study']);
  });
  it('keeps null last even when it appears first', () => {
    expect(orderCohorts([null, 'pilot'])).toEqual(['pilot', null]);
  });
});

describe('groupByCohort', () => {
  it('buckets participants by cohort in display order', () => {
    const groups = groupByCohort(PARTICIPANTS);
    expect(groups.map((g) => g.cohort)).toEqual(['pilot', 'study', null]);
    expect(groups[0].pids).toEqual(['a']);
    expect(groups[1].pids).toEqual(['b', 'c']);
    expect(groups[2].pids).toEqual(['d']);
  });
  it('returns an empty list for no participants', () => {
    expect(groupByCohort([])).toEqual([]);
  });
});

describe('selectAll / deselectAll', () => {
  it('selectAll includes every pid', () => {
    const sel = selectAll(PARTICIPANTS);
    expect(sel.size).toBe(4);
    expect([...sel].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('deselectAll is empty', () => {
    expect(deselectAll().size).toBe(0);
  });
});

describe('toggle', () => {
  it('adds a pid when absent then removes it when present', () => {
    const added = toggle(new Set<string>(), 'a');
    expect(added.has('a')).toBe(true);
    const removed = toggle(added, 'a');
    expect(removed.has('a')).toBe(false);
  });
  it('does not mutate the input set', () => {
    const input = new Set<string>(['x']);
    toggle(input, 'y');
    expect([...input]).toEqual(['x']);
  });
});

describe('selectCohort', () => {
  it('adds only that cohort’s pids and leaves others untouched', () => {
    const start = new Set<string>(['a']); // a pilot pid pre-selected
    const next = selectCohort(start, PARTICIPANTS, 'study');
    expect([...next].sort()).toEqual(['a', 'b', 'c']);
  });
  it('is addressable for the null cohort', () => {
    const next = selectCohort(new Set<string>(), PARTICIPANTS, null);
    expect([...next]).toEqual(['d']);
  });
});

describe('deselectCohort', () => {
  it('removes only that cohort’s pids and leaves others', () => {
    const start = selectAll(PARTICIPANTS);
    const next = deselectCohort(start, PARTICIPANTS, 'study');
    expect([...next].sort()).toEqual(['a', 'd']);
  });
});

describe('cohortSelectionState', () => {
  it('none when nothing in the cohort is selected', () => {
    expect(cohortSelectionState(new Set(['a']), PARTICIPANTS, 'study')).toBe('none');
  });
  it('some when a strict subset of the cohort is selected', () => {
    expect(cohortSelectionState(new Set(['b']), PARTICIPANTS, 'study')).toBe('some');
  });
  it('all when the whole cohort is selected', () => {
    expect(cohortSelectionState(new Set(['b', 'c']), PARTICIPANTS, 'study')).toBe('all');
  });
  it('is addressable for the null cohort', () => {
    expect(cohortSelectionState(new Set(['d']), PARTICIPANTS, null)).toBe('all');
  });
});

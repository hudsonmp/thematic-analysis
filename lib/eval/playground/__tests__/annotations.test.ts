import { describe, expect, it } from 'vitest';
import {
  contextLabel,
  selectableCheckedIds,
  type PendingAnnotation,
} from '../annotations';

describe('selectableCheckedIds', () => {
  // The fold action refuses a PARTIAL fold: it throws when the resolved-count
  // (rows still present in the DB) !== the requested Set size. The checkbox
  // list is fetched once and refreshed after saves/folds, so a checked id can
  // go stale (its row got folded in a prior fold, or was removed). This helper
  // pins the fold's id set to the ids STILL AVAILABLE in the current list, so a
  // stale check can never spuriously trip the action's partial-fold refusal.
  it('keeps only checked ids that are still available, in available order', () => {
    expect(selectableCheckedIds(new Set(['b', 'stale', 'a']), ['a', 'b', 'c'])).toEqual([
      'a',
      'b',
    ]);
  });

  it('de-dupes to the available list (available ids are unique DB ids)', () => {
    // A duplicate available id would already be a DB anomaly; the output mirrors
    // the available list exactly once so it matches the action's `new Set` count.
    expect(selectableCheckedIds(new Set(['x']), ['x', 'y'])).toEqual(['x']);
  });

  it('returns [] when nothing checked or nothing available', () => {
    expect(selectableCheckedIds(new Set(), ['a', 'b'])).toEqual([]);
    expect(selectableCheckedIds(new Set(['a']), [])).toEqual([]);
  });

  it('drops ALL checked ids when none remain available (avoids a doomed fold)', () => {
    expect(selectableCheckedIds(new Set(['gone']), ['a'])).toEqual([]);
  });
});

describe('contextLabel', () => {
  function a(over: Partial<PendingAnnotation>): PendingAnnotation {
    return { note: 'n', localKey: 'k', ...over };
  }

  it('prefers the pid · phase · scenario coordinates when known', () => {
    expect(contextLabel(a({ pid: 'P07', phaseOrdinal: 2, scenarioIdx: 1 }))).toBe('P07 · phase 2 · sc 1');
  });

  it('omits a null scenario coordinate', () => {
    expect(contextLabel(a({ pid: 'P07', phaseOrdinal: 0, scenarioIdx: null }))).toBe('P07 · phase 0');
  });

  it('falls back to verdict id, then run id, then unscoped', () => {
    expect(contextLabel(a({ verdictId: 'v1' }))).toBe('verdict v1');
    expect(contextLabel(a({ runId: 'r1' }))).toBe('run r1');
    expect(contextLabel(a({}))).toBe('unscoped');
  });
});

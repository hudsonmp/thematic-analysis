import { describe, expect, it } from 'vitest';
import {
  annotationInsertRow,
  contextLabel,
  mapAnnotationRow,
  selectableCheckedIds,
  type PendingAnnotation,
} from '../annotations';

describe('annotationInsertRow', () => {
  it('maps camelCase input → snake_case insert row WITHOUT transposing coordinates', () => {
    // Distinct numeric coordinates so a phaseOrdinal↔scenarioIdx swap at the
    // WRITE site (both numbers, tsc-invisible) fails this assertion — the write
    // path files notes under a scenario permanently, so it must be pinned too.
    expect(
      annotationInsertRow({
        note: 'n',
        runId: 'RUN-1',
        verdictId: 'VERDICT-9',
        pid: '042',
        phaseOrdinal: 2,
        scenarioIdx: 3,
      }),
    ).toEqual({
      note: 'n',
      run_id: 'RUN-1',
      verdict_id: 'VERDICT-9',
      pid: '042',
      phase_ordinal: 2,
      scenario_idx: 3,
    });
  });

  it('defaults every optional field to null when absent', () => {
    expect(annotationInsertRow({ note: 'n' })).toEqual({
      note: 'n',
      run_id: null,
      verdict_id: null,
      pid: null,
      phase_ordinal: null,
      scenario_idx: null,
    });
  });
});

describe('mapAnnotationRow', () => {
  it('renames snake_case DB columns to camelCase WITHOUT transposing fields', () => {
    // Distinct run/verdict values so a run_id→verdictId transposition (which
    // type-checks — both are strings) fails this assertion, not just tsc.
    // phase_ordinal / scenario_idx are DISTINCT numbers so a
    // phase_ordinal→scenarioIdx transposition (both numbers — type-checks)
    // fails this assertion, not just tsc.
    expect(
      mapAnnotationRow({
        id: 'a1',
        note: 'n',
        run_id: 'RUN-1',
        verdict_id: 'VERDICT-9',
        pid: 'P07',
        phase_ordinal: 2,
        scenario_idx: 3,
        created_at: '2026-07-04T00:00:00Z',
      }),
    ).toEqual({
      id: 'a1',
      note: 'n',
      runId: 'RUN-1',
      verdictId: 'VERDICT-9',
      pid: 'P07',
      phaseOrdinal: 2,
      scenarioIdx: 3,
      createdAt: '2026-07-04T00:00:00Z',
    });
  });

  it('preserves nulls for run_id / verdict_id / pid / phase_ordinal / scenario_idx', () => {
    expect(
      mapAnnotationRow({
        id: 'a1',
        note: 'n',
        run_id: null,
        verdict_id: null,
        pid: null,
        phase_ordinal: null,
        scenario_idx: null,
        created_at: 't',
      }),
    ).toMatchObject({
      runId: null,
      verdictId: null,
      pid: null,
      phaseOrdinal: null,
      scenarioIdx: null,
    });
  });
});

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

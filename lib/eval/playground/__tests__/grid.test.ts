import { describe, it, expect } from 'vitest';
import type { VerdictRow } from '@/app/actions/runs';
import { buildGrid, meanScorePerPhase, phaseDeltas, type GridCell } from '@/lib/eval/playground/grid';

// ---------------------------------------------------------------------------
// grid.ts — pivot flat verdicts into participant rows × phase columns, and
// compute the per-phase improvement deltas. The "honest-signal" rule (an
// ungradable phase yields a NULL delta, never 0) is the load-bearing case
// pinned below: a delta of 0 would falsely read as "no change" when the truth
// is "we could not measure change".
// ---------------------------------------------------------------------------

/** Build a verdict row with sane defaults; override per test. */
function v(over: Partial<VerdictRow>): VerdictRow {
  return {
    id: `${over.pid ?? 'P'}-${over.phaseOrdinal ?? 0}-${over.scenarioIdx ?? 0}`,
    runId: 'run1',
    pid: 'P1',
    phaseOrdinal: 0,
    scenarioIdx: 0,
    pass: true,
    score: 1,
    rationale: '',
    evidence: null,
    ...over,
  };
}

/** A full 2 pids × 5 phases × 4 scenarios verdict fixture, score = 0.5 flat so
 *  every phase mean is 0.5 and every delta is 0 (the concordant baseline). */
function fullFixture(): VerdictRow[] {
  const rows: VerdictRow[] = [];
  for (const pid of ['P1', 'P2']) {
    for (let phase = 0; phase < 5; phase++) {
      for (let sc = 0; sc < 4; sc++) {
        rows.push(v({ pid, phaseOrdinal: phase, scenarioIdx: sc, score: 0.5, pass: false }));
      }
    }
  }
  return rows;
}

/** Cells for ONE pid from a set of (phase, score) pairs — one scenario each. */
function cellsOf(pairs: { phase: number; score: number | null }[]): GridCell[] {
  return pairs.map((p, i) => ({
    pid: 'P1',
    phaseOrdinal: p.phase,
    scenarioIdx: 0,
    pass: p.score === null ? null : p.score >= 0.8,
    score: p.score,
    verdictId: `c${i}`,
  }));
}

describe('buildGrid', () => {
  it('pivots 2 pids × 5 phases × 4 scenarios into 2 rows of 20 cells each', () => {
    const grid = buildGrid(fullFixture(), [
      { pid: 'P1', cohort: 'pilot' },
      { pid: 'P2', cohort: 'study' },
    ]);
    expect(grid).toHaveLength(2);
    expect(grid[0].cells).toHaveLength(20);
    expect(grid[1].cells).toHaveLength(20);
  });

  it('carries cohort from the participants arg (join by pid), NOT from verdicts', () => {
    const grid = buildGrid(fullFixture(), [
      { pid: 'P1', cohort: 'pilot' },
      { pid: 'P2', cohort: 'study' },
    ]);
    const p1 = grid.find((r) => r.pid === 'P1');
    const p2 = grid.find((r) => r.pid === 'P2');
    expect(p1?.cohort).toBe('pilot');
    expect(p2?.cohort).toBe('study');
  });

  it('carries a null cohort for a pid absent from the participants arg', () => {
    const grid = buildGrid(fullFixture(), [{ pid: 'P1', cohort: 'pilot' }]);
    const p2 = grid.find((r) => r.pid === 'P2');
    expect(p2?.cohort).toBeNull();
  });

  it('produces one row per pid PRESENT IN THE VERDICTS (verdict-driven rows)', () => {
    const grid = buildGrid(
      [v({ pid: 'P1', phaseOrdinal: 0, scenarioIdx: 0, score: 0.5 })],
      [
        { pid: 'P1', cohort: 'pilot' },
        { pid: 'P2', cohort: 'study' }, // has no verdicts → no row
      ],
    );
    expect(grid).toHaveLength(1);
    expect(grid[0].pid).toBe('P1');
  });

  it('each row carries meanScorePerPhase-derived phaseDeltas of length 5, deltas[0] null', () => {
    const grid = buildGrid(fullFixture(), [
      { pid: 'P1', cohort: 'pilot' },
      { pid: 'P2', cohort: 'study' },
    ]);
    expect(grid[0].phaseDeltas).toHaveLength(5);
    expect(grid[0].phaseDeltas[0]).toBeNull();
    // flat 0.5 everywhere → deltas 1..4 are 0
    expect(grid[0].phaseDeltas.slice(1)).toEqual([0, 0, 0, 0]);
  });

  it('propagates an ungradable phase to null deltas END-TO-END through buildGrid (gate pin)', () => {
    // P1 is gradable at every phase EXCEPT phase 2, where all 4 scenario scores
    // are null. The honest-signal rule must survive the full pivot: phase 2's
    // own delta AND phase 3's delta (its successor) are null, not 0 — while the
    // still-gradable phases 1 and 4 keep real numeric deltas.
    const rows: VerdictRow[] = [];
    for (let phase = 0; phase < 5; phase++) {
      for (let sc = 0; sc < 4; sc++) {
        const score = phase === 2 ? null : 0.5;
        rows.push(
          v({ pid: 'P1', phaseOrdinal: phase, scenarioIdx: sc, score, pass: score === null ? null : false }),
        );
      }
    }
    const grid = buildGrid(rows, [{ pid: 'P1', cohort: 'pilot' }]);
    const d = grid[0].phaseDeltas;
    expect(d[0]).toBeNull(); // no prior phase
    expect(d[1]).toBe(0); // phase 1 vs phase 0, both 0.5 → gradable zero, NOT null
    expect(d[2]).toBeNull(); // phase 2 ungradable → its own delta null
    expect(d[3]).toBeNull(); // phase 3's prior neighbor (2) ungradable → null
    expect(d[4]).toBe(0); // phase 4 vs phase 3, both gradable again → real 0
  });
});

describe('meanScorePerPhase', () => {
  it('returns a length-5 array indexed by phase ordinal 0..4', () => {
    const means = meanScorePerPhase(cellsOf([{ phase: 0, score: 0.5 }]));
    expect(means).toHaveLength(5);
  });

  it('averages non-null scores within a phase (two scenarios at phase 1)', () => {
    const cells: GridCell[] = [
      { pid: 'P1', phaseOrdinal: 1, scenarioIdx: 0, pass: false, score: 0.4, verdictId: 'a' },
      { pid: 'P1', phaseOrdinal: 1, scenarioIdx: 1, pass: true, score: 0.8, verdictId: 'b' },
    ];
    const means = meanScorePerPhase(cells);
    expect(means[1]).toBeCloseTo(0.6);
  });

  it('ignores null scores when averaging (a null cell does not drag the mean)', () => {
    const cells: GridCell[] = [
      { pid: 'P1', phaseOrdinal: 2, scenarioIdx: 0, pass: true, score: 1, verdictId: 'a' },
      { pid: 'P1', phaseOrdinal: 2, scenarioIdx: 1, pass: null, score: null, verdictId: 'b' },
    ];
    const means = meanScorePerPhase(cells);
    expect(means[2]).toBe(1); // mean of just the one gradable cell
  });

  it('returns null for a phase with zero gradable (all-null) cells', () => {
    const cells: GridCell[] = [
      { pid: 'P1', phaseOrdinal: 3, scenarioIdx: 0, pass: null, score: null, verdictId: 'a' },
      { pid: 'P1', phaseOrdinal: 3, scenarioIdx: 1, pass: null, score: null, verdictId: 'b' },
    ];
    expect(meanScorePerPhase(cells)[3]).toBeNull();
  });

  it('returns null for a phase with no cells at all', () => {
    const means = meanScorePerPhase(cellsOf([{ phase: 0, score: 0.5 }]));
    expect(means[4]).toBeNull();
  });
});

describe('phaseDeltas', () => {
  it('deltas[0] is null — there is no prior phase', () => {
    const means = meanScorePerPhase(cellsOf([{ phase: 0, score: 0.5 }]));
    expect(phaseDeltas(means)[0]).toBeNull();
  });

  it('deltas[k] = mean[k] - mean[k-1] when both neighbors are gradable', () => {
    const means = meanScorePerPhase(
      cellsOf([
        { phase: 0, score: 0.2 },
        { phase: 1, score: 0.5 },
        { phase: 2, score: 0.4 },
      ]),
    );
    const d = phaseDeltas(means);
    expect(d[1]).toBeCloseTo(0.3); // 0.5 - 0.2
    expect(d[2]).toBeCloseTo(-0.1); // 0.4 - 0.5
  });

  it('an ungradable (all-null) phase yields a NULL delta, NOT 0 — the honest-signal rule', () => {
    // phase 1 is ungradable → mean[1] = null.
    const means = meanScorePerPhase(
      cellsOf([
        { phase: 0, score: 0.5 },
        { phase: 1, score: null }, // ungradable
        { phase: 2, score: 0.9 },
      ]),
    );
    const d = phaseDeltas(means);
    // delta at the ungradable phase itself is null (its own mean is null)...
    expect(d[1]).toBeNull();
    expect(d[1]).not.toBe(0);
    // ...AND the next phase's delta is null too — its prior neighbor is null.
    expect(d[2]).toBeNull();
    expect(d[2]).not.toBe(0);
  });

  it('a null delta is distinct from a genuine 0 delta (no-change vs cannot-measure)', () => {
    const means = meanScorePerPhase(
      cellsOf([
        { phase: 0, score: 0.5 },
        { phase: 1, score: 0.5 }, // genuine no-change
      ]),
    );
    const d = phaseDeltas(means);
    expect(d[1]).toBe(0); // measured, unchanged
    expect(d[1]).not.toBeNull();
  });
});
